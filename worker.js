import PAGE from "./admin.html";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return admin(req, env, url);
    return proxy(req, env, url, ctx);
  },
};

// USD per million tokens, Anthropic list prices. Haiku 5.5 is 5x above 100K prompt tokens.
// Cache writes bill at 1.25x input (5m) or 2x input (1h).
// ponytail: Haiku cache-read price assumed 0.1x input; check against the pricing page.
const PRICES = {
  opus: { in: 4, out: 20, read: 0.2 },
  sonnet: { in: 2, out: 10, read: 0.2 },
  haiku: { in: 0.1, out: 0.5, read: 0.01, longScale: 5 },
};

export function cost(model, usage) {
  const family = /(opus|sonnet|haiku)-5[-.]5/.exec(String(model).toLowerCase())?.[1];
  if (!family) return null;
  const p = PRICES[family];
  const fresh = usage.input_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
  const scale = p.longScale && fresh + read + write > 100e3 ? p.longScale : 1;
  const usd = fresh * p.in + read * p.read + (write - write1h) * p.in * 1.25 + write1h * p.in * 2 + (usage.output_tokens || 0) * p.out;
  return (usd * scale) / 1e6;
}

function extract(text, type) {
  if (!type?.includes("event-stream")) {
    const m = JSON.parse(text);
    return { model: m.model, usage: m.usage };
  }
  let model;
  const usage = {};
  for (const line of text.split("\n")) {
    // Free plan allows 10ms CPU: skip the many content_block_delta lines without parsing them.
    if (!line.startsWith("data:") || !/"message_(start|delta)"/.test(line)) continue;
    let ev;
    try { ev = JSON.parse(line.slice(5)); } catch { continue; }
    if (ev.type === "message_start") model = ev.message.model;
    const u = ev.type === "message_start" ? ev.message.usage : ev.type === "message_delta" ? ev.usage : null;
    for (const [k, v] of Object.entries(u || {})) if (v != null) usage[k] = v;
  }
  return { model, usage };
}

// One Durable Object per gateway key. A Durable Object runs one request at a time,
// so concurrent calls on a key cannot lose updates the way a KV read-modify-write would.
export class Meter {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(req) {
    if (req.method === "DELETE") {
      await this.storage.deleteAll();
      return Response.json({ ok: true });
    }
    const models = (await this.storage.get("models")) || {};
    if (req.method === "POST") {
      const { model, input, output, cost: usd } = await req.json();
      const m = (models[model] ||= { requests: 0, input: 0, output: 0, cost: 0, priced: true });
      m.requests++;
      m.input += input;
      m.output += output;
      if (usd == null) m.priced = false;
      else m.cost += usd;
      await this.storage.put("models", models);
    }
    return Response.json(models);
  }
}

const meter = (env, id, init) => env.METER.get(env.METER.idFromName(id)).fetch("https://meter/", init);

async function record(env, id, res) {
  try {
    const { model, usage } = extract(await res.text(), res.headers.get("content-type"));
    if (!model || !usage) return;
    await meter(env, id, {
      method: "POST",
      body: JSON.stringify({
        model,
        input: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
        output: usage.output_tokens || 0,
        cost: cost(model, usage),
      }),
    });
  } catch {
    // Metering must never break proxying.
  }
}

async function proxy(req, env, url, ctx) {
  const presented = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || req.headers.get("x-api-key") || "";
  // KV rejects keys over 512 bytes, so oversized input must not reach it.
  const route = presented && presented.length <= 128 ? await env.KEYS.get(presented, "json") : null;
  if (!route || !(Date.now() < Date.parse(route.expires))) return json(401, "invalid or expired key");

  const headers = new Headers(req.headers);
  headers.delete("x-api-key");
  headers.set("authorization", `Bearer ${route.key}`);
  // api.anthropic.com authenticates API keys with x-api-key, not Bearer.
  if (route.base.includes("api.anthropic.com")) headers.set("x-api-key", route.key);
  for (const h of ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"]) headers.delete(h);

  // Clients use <gateway>/v1; the stored base is the provider's own base URL, which may end in /v1, /v4 or nothing.
  const path = url.pathname.replace(/^\/v1(?=\/|$)/, "");
  try {
    // Anthropic's base has no /v1 prefix of its own, so a bare host would 404.
    const base = route.base === "https://api.anthropic.com" ? route.base + "/v1" : route.base;
    const res = await fetch(base + path + url.search, { method: req.method, headers, body: req.body });
    if (ctx && req.method === "POST" && path === "/messages" && res.ok) ctx.waitUntil(record(env, presented, res.clone()));
    return res;
  } catch (err) {
    return json(502, `upstream unreachable: ${err.message}`);
  }
}

async function admin(req, env, url) {
  if (!(await authorized(req, env))) {
    return new Response("login required", { status: 401, headers: { "www-authenticate": 'Basic realm="Key Router admin"' } });
  }
  if (url.pathname === "/admin") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });

  if (url.pathname === "/admin/keys" && req.method === "GET") {
    const keys = (await env.KEYS.list()).keys.filter((k) => k.name.startsWith("sk-gw-"));
    return Response.json(await Promise.all(keys.map(async (k) => ({
      id: k.name,
      ...k.metadata,
      usage: await (await meter(env, k.name)).json(),
    }))));
  }

  // Requiring a JSON content type forces a CORS preflight, so other sites cannot create keys with cached credentials.
  if (url.pathname === "/admin/keys" && req.method === "POST" && req.headers.get("content-type") === "application/json") {
    const { base, key, expires } = await req.json().catch(() => ({}));
    const exp = Date.parse(expires);
    if (!/^https:\/\/\S+$/.test(base || "") || !key || !(exp > Date.now() + 60e3)) {
      return json(400, "need an https endpoint, an API key, and an expiry at least a minute away");
    }
    const id = "sk-gw-" + crypto.randomUUID().replaceAll("-", "");
    const route = { base: base.replace(/\/+$/, ""), key, expires: new Date(exp).toISOString() };
    await env.KEYS.put(id, JSON.stringify(route), {
      expiration: Math.floor(exp / 1000),
      metadata: { base: route.base, expires: route.expires },
    });
    return Response.json({ id, base: route.base, expires: route.expires });
  }

  const match = url.pathname.match(/^\/admin\/keys\/(sk-gw-[0-9a-f]{32})$/);
  if (match && req.method === "DELETE") {
    await env.KEYS.delete(match[1]);
    await meter(env, match[1], { method: "DELETE" });
    return Response.json({ ok: true });
  }
  return json(404, "not found");
}

async function authorized(req, env) {
  const [scheme, encoded] = (req.headers.get("authorization") || "").split(" ");
  if (scheme !== "Basic" || !encoded || !env.ADMIN_PASSWORD) return false;
  let password;
  try {
    password = atob(encoded).split(":").slice(1).join(":");
  } catch {
    return false;
  }
  const a = new TextEncoder().encode(password);
  const b = new TextEncoder().encode(env.ADMIN_PASSWORD);
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}

function json(status, message) {
  return Response.json({ error: { message } }, { status });
}
