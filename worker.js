import PAGE from "./admin.html";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return admin(req, env, url);
    return proxy(req, env, url, ctx);
  },
};

const KEY_ID = /^sk-gw-[0-9a-f]{32}$/;
// Expired keys stay listed this long so their spend stays visible; the real key itself is wiped at expiry.
const RETAIN = 30 * 864e5;
// Header the real key travels in: Bearer (OpenAI style), Anthropic, Azure, Gemini.
const AUTH_STYLES = ["bearer", "x-api-key", "api-key", "x-goog-api-key"];
// Client identity, cookies and the gateway key itself must never reach the provider.
const STRIP = /^(cf-|x-forwarded-|x-real-ip$|cookie$|origin$|referer$|authorization$|x-api-key$|api-key$|x-goog-api-key$)/;
const METERED = new Set(["/messages", "/chat/completions", "/responses"]);

// USD per million tokens, Anthropic list prices. Haiku 5.5 is 5x above 100K prompt tokens.
// Cache writes bill at 1.25x input (5m) or 2x input (1h).
// shortcut: Haiku cache-read price assumed 0.1x input, check it against the pricing page before trusting Haiku totals.
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

// OpenAI counts cached tokens inside the prompt total; Anthropic counts them separately.
function normalize(u) {
  if (!u || (u.prompt_tokens == null && !u.input_tokens_details)) return u || {};
  const total = u.prompt_tokens ?? u.input_tokens ?? 0;
  const cached = (u.prompt_tokens_details || u.input_tokens_details)?.cached_tokens || 0;
  return { input_tokens: total - cached, cache_read_input_tokens: cached, output_tokens: u.completion_tokens ?? u.output_tokens };
}

// Handles Anthropic Messages, OpenAI Chat Completions and OpenAI Responses bodies, streamed or not.
function extract(text, type) {
  const chunks = type?.includes("event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5))
    : [text];
  let model;
  const usage = {};
  for (const raw of chunks) {
    let ev;
    try { ev = JSON.parse(raw); } catch { continue; }
    const o = ev.message || ev.response || ev;
    model ||= o.model;
    for (const [k, v] of Object.entries(normalize(o.usage || ev.usage))) if (v != null) usage[k] = v;
  }
  return { model, usage };
}

// One Durable Object per gateway key. A Durable Object runs one request at a time,
// so concurrent calls on a key cannot lose updates the way a KV read-modify-write would.
export class Meter {
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
  }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method === "DELETE") return Response.json(await this.wipe());
    if (path === "/schedule") {
      const { id, expires } = await req.json();
      await this.storage.put("key", { id, expires });
      await this.storage.setAlarm(Date.parse(expires));
      return Response.json({ ok: true });
    }
    const models = (await this.storage.get("models")) || {};
    if (path === "/admit") {
      const { cap, rpm } = await req.json();
      const spent = Object.values(models).reduce((sum, m) => sum + m.cost, 0);
      if (cap && spent >= cap) return json(429, `spend cap of $${cap} reached`);
      if (rpm) {
        const now = Date.now();
        const hits = ((await this.storage.get("hits")) || []).filter((t) => t > now - 60e3);
        if (hits.length >= rpm) return json(429, `rate limit of ${rpm} requests per minute reached`);
        hits.push(now);
        await this.storage.put("hits", hits);
      }
      return Response.json({ ok: true });
    }
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

  // Fires at expiry to wipe the real key, then again at the end of retention to drop the record.
  async alarm() {
    const { id, expires } = (await this.storage.get("key")) || {};
    if (!id) return;
    const purge = Date.parse(expires) + RETAIN;
    if (Date.now() >= purge) return void (await this.wipe());
    const { value, metadata } = await this.env.KEYS.getWithMetadata(id, "json");
    if (value?.key) await this.env.KEYS.put(id, JSON.stringify({ ...value, key: null }), { expiration: Math.floor(purge / 1000), metadata });
    await this.storage.setAlarm(purge);
  }

  async wipe() {
    await this.storage.deleteAlarm();
    await this.storage.deleteAll();
    return { ok: true };
  }
}

const meter = (env, id, path, init) => env.METER.get(env.METER.idFromName(id)).fetch("https://meter" + path, init);

async function record(env, id, res) {
  try {
    const { model, usage } = extract(await res.text(), res.headers.get("content-type"));
    if (!model || !Object.keys(usage).length) return;
    await meter(env, id, "/", {
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

// Gateway keys travel in headers, never cookies, so any origin may call the proxy.
function cors(res, req) {
  const out = new Response(res.body, res);
  out.headers.set("access-control-allow-origin", "*");
  if (req.method === "OPTIONS") {
    out.headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE");
    out.headers.set("access-control-allow-headers", req.headers.get("access-control-request-headers") || "*");
    out.headers.set("access-control-max-age", "86400");
  }
  return out;
}

const allowed = (patterns, model) =>
  typeof model === "string" && patterns.some((p) => (p.endsWith("*") ? model.startsWith(p.slice(0, -1)) : p === model));

async function proxy(req, env, url, ctx) {
  if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }), req);
  const h = req.headers;
  const presented = h.get("authorization")?.replace(/^Bearer\s+/i, "") || h.get("x-api-key") || h.get("api-key") || h.get("x-goog-api-key") || "";
  // Only well-formed ids reach KV, so random tokens cannot burn the daily KV read quota.
  const route = KEY_ID.test(presented) ? await env.KEYS.get(presented, "json") : null;
  if (!route?.key || !(Date.now() < Date.parse(route.expires))) return cors(json(401, "invalid or expired key"), req);

  let body = req.body;
  if (route.models?.length && req.method === "POST") {
    body = await req.text();
    let model;
    try { model = JSON.parse(body).model; } catch {}
    if (!allowed(route.models, model)) return cors(json(403, `model ${model ?? "(none)"} is not allowed for this key`), req);
  }
  if (route.cap || route.rpm) {
    const verdict = await meter(env, presented, "/admit", { method: "POST", body: JSON.stringify({ cap: route.cap, rpm: route.rpm }) });
    if (!verdict.ok) return cors(verdict, req);
  }

  const headers = new Headers();
  for (const [k, v] of h) if (!STRIP.test(k)) headers.set(k, v);
  const style = route.auth || "bearer";
  headers.set(style === "bearer" ? "authorization" : style, style === "bearer" ? `Bearer ${route.key}` : route.key);

  // Clients use <gateway>/v1; the stored base is the provider's own base URL, which may end in /v1, /v4 or nothing.
  const path = url.pathname.replace(/^\/v1(?=\/|$)/, "");
  try {
    // A followed redirect would carry the real key to whatever host the provider names.
    const res = await fetch(route.base + path + url.search, { method: req.method, headers, body, redirect: "manual" });
    if (ctx && req.method === "POST" && METERED.has(path) && res.ok) ctx.waitUntil(record(env, presented, res.clone()));
    return cors(res, req);
  } catch (err) {
    return cors(json(502, `upstream unreachable: ${err.message}`), req);
  }
}

// Validates every non-secret setting of a key.
function settings({ expires, auth = "bearer", label = "", cap = null, rpm = null, models = [] }) {
  const exp = Date.parse(expires);
  if (!(exp > Date.now() + 60e3)) return { error: "expiry must be at least a minute away" };
  if (!AUTH_STYLES.includes(auth)) return { error: `auth must be one of ${AUTH_STYLES.join(", ")}` };
  if (cap != null && !(Number(cap) > 0)) return { error: "spend cap must be a positive number of dollars" };
  if (rpm != null && !(Number.isInteger(Number(rpm)) && Number(rpm) > 0)) return { error: "rate limit must be a whole number of requests per minute" };
  if (!Array.isArray(models) || !models.every((m) => typeof m === "string" && m)) return { error: "models must be a list of model names" };
  const out = { expires: new Date(exp).toISOString(), auth, label: String(label).slice(0, 100), models };
  if (cap != null) out.cap = Number(cap);
  if (rpm != null) out.rpm = Number(rpm);
  return out;
}

async function save(env, id, route) {
  const { key, ...metadata } = route;
  if (JSON.stringify(metadata).length > 1024) return json(400, "settings too long to store; shorten the label or model list");
  // Schedule the wipe first, so a stored real key always has one.
  await meter(env, id, "/schedule", { method: "POST", body: JSON.stringify({ id, expires: route.expires }) });
  await env.KEYS.put(id, JSON.stringify(route), { expiration: Math.floor((Date.parse(route.expires) + RETAIN) / 1000), metadata });
  return Response.json({ id, ...metadata });
}

const isJson = (req) => req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json";

async function admin(req, env, url) {
  if (!(await authorized(req, env))) {
    return new Response("login required", { status: 401, headers: { "www-authenticate": 'Basic realm="Key Router admin"' } });
  }
  if (url.pathname === "/admin") {
    return new Response(PAGE, {
      headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY" },
    });
  }

  if (url.pathname === "/admin/keys" && req.method === "GET") {
    const keys = [];
    let cursor;
    do {
      const page = await env.KEYS.list({ prefix: "sk-gw-", cursor });
      keys.push(...page.keys);
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    return Response.json(await Promise.all(keys.map(async (k) => ({
      id: k.name,
      ...k.metadata,
      usage: await (await meter(env, k.name, "/")).json(),
    }))));
  }

  // Requiring a JSON content type forces a CORS preflight, so other sites cannot change keys with cached credentials.
  if (url.pathname === "/admin/keys" && req.method === "POST" && isJson(req)) {
    const body = await req.json().catch(() => ({}));
    if (!/^https:\/\/\S+$/.test(body.base || "") || !body.key) return json(400, "need an https endpoint and an API key");
    const s = settings(body);
    if (s.error) return json(400, s.error);
    const id = "sk-gw-" + crypto.randomUUID().replaceAll("-", "");
    return save(env, id, { base: body.base.replace(/\/+$/, ""), key: body.key, ...s });
  }

  const match = url.pathname.match(/^\/admin\/keys\/(sk-gw-[0-9a-f]{32})$/);
  if (match && req.method === "PATCH" && isJson(req)) {
    const route = await env.KEYS.get(match[1], "json");
    if (!route?.key || !(Date.now() < Date.parse(route.expires))) return json(404, "no active key with that id");
    const s = settings({ ...route, ...(await req.json().catch(() => ({}))) });
    if (s.error) return json(400, s.error);
    return save(env, match[1], { base: route.base, key: route.key, ...s });
  }
  if (match && req.method === "DELETE") {
    await env.KEYS.delete(match[1]);
    await meter(env, match[1], "/", { method: "DELETE" });
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
