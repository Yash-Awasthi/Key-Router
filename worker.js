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
const OUTPUT_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"];
const LIMITS = { capUsd: "spend cap", capTokens: "token cap", rpm: "rate limit", maxOutput: "max output tokens" };

// USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-12).
// The longest matching name wins, so "claude-opus-5" does not price claude-opus-5-5.
export const DEFAULT_PRICES = [
  { match: "claude-fable-5-1", in: 10, out: 50, read: 0.25, write5m: 12.5, write1h: 20 },
  { match: "claude-mythos-5-1", in: 10, out: 50, read: 0.25, write5m: 12.5, write1h: 20 },
  { match: "claude-fable-5", in: 10, out: 50, read: 1, write5m: 12.5, write1h: 20 },
  { match: "claude-mythos-5", in: 10, out: 50, read: 1, write5m: 12.5, write1h: 20 },
  { match: "claude-opus-5-5", in: 4, out: 20, read: 0.2, write5m: 5, write1h: 8, fast: 2 },
  { match: "claude-opus-5", in: 5, out: 25, read: 0.5, write5m: 6.25, write1h: 10, fast: 2 },
  { match: "claude-opus-4-8", in: 5, out: 25, read: 0.5, write5m: 6.25, write1h: 10, fast: 2 },
  { match: "claude-opus-4-7", in: 5, out: 25, read: 0.5, write5m: 6.25, write1h: 10 },
  { match: "claude-opus-4-6", in: 5, out: 25, read: 0.5, write5m: 6.25, write1h: 10 },
  { match: "claude-sonnet-5-5", in: 2, out: 10, read: 0.1, write5m: 2.5, write1h: 4 },
  { match: "claude-sonnet-5", in: 2, out: 10, read: 0.2, write5m: 2.5, write1h: 4 },
  { match: "claude-sonnet-4-6", in: 3, out: 15, read: 0.3, write5m: 3.75, write1h: 6 },
  { match: "claude-haiku-5-5", in: 0.1, out: 0.5, read: 0.01, write5m: 0.125, write1h: 0.2, longAbove: 100e3, longScale: 5 },
  { match: "claude-haiku-4-5", in: 1, out: 5, read: 0.1, write5m: 1.25, write1h: 2 },
];
const PRICE_FIELDS = ["in", "out", "read", "write5m", "write1h"];
const PRICE_OPTIONAL = ["longAbove", "longScale", "fast"];
const slug = (s) => String(s).toLowerCase().replaceAll(".", "-");

export function cost(model, usage, prices = DEFAULT_PRICES) {
  const id = slug(model);
  const p = prices.filter((r) => id.includes(slug(r.match))).sort((a, b) => b.match.length - a.match.length)[0];
  if (!p) return null;
  const fresh = usage.input_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
  // Long-context, fast-mode and US-residency multipliers stack on every rate, cache included.
  let scale = p.longAbove && fresh + read + write > p.longAbove ? p.longScale || 1 : 1;
  if (usage.speed === "fast") scale *= p.fast || 1;
  if (usage.inference_geo === "us") scale *= 1.1;
  const usd = fresh * p.in + read * p.read + (write - write1h) * p.write5m + write1h * p.write1h + (usage.output_tokens || 0) * p.out;
  return (usd * scale) / 1e6;
}

// Prices are read on every metered call, so each isolate keeps them for a minute instead of reading KV each time.
let priceCache = { at: 0, rows: null };
async function prices(env) {
  if (Date.now() - priceCache.at > 60e3) priceCache = { at: Date.now(), rows: (await env.KEYS.get("config:prices", "json")) || DEFAULT_PRICES };
  return priceCache.rows;
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

const month = () => new Date().toISOString().slice(0, 7);
const sum = (bucket = {}) =>
  Object.values(bucket).reduce((s, m) => ({ usd: s.usd + m.cost, tokens: s.tokens + m.input + m.output }), { usd: 0, tokens: 0 });

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
    if (path === "/reset") {
      await this.storage.delete(["models", "months", "hits"]);
      return Response.json({ ok: true });
    }
    if (path === "/schedule") {
      const { id, expires } = await req.json();
      await this.storage.put("key", { id, expires });
      await this.storage.setAlarm(Date.parse(expires));
      return Response.json({ ok: true });
    }
    const total = (await this.storage.get("models")) || {};
    const months = (await this.storage.get("months")) || {};
    if (path === "/admit") {
      const { capUsd, capTokens, period, rpm } = await req.json();
      const used = sum(period === "month" ? months[month()] : total);
      const when = period === "month" ? " for this month" : "";
      if (capUsd && used.usd >= capUsd) return json(429, `spend cap of $${capUsd}${when} reached`);
      if (capTokens && used.tokens >= capTokens) return json(429, `token cap of ${capTokens}${when} reached`);
      if (rpm) {
        const now = Date.now();
        const hits = ((await this.storage.get("hits")) || []).filter((t) => t > now - 60e3);
        if (hits.length >= rpm) return json(429, `rate limit reached (${rpm} per minute)`);
        hits.push(now);
        await this.storage.put("hits", hits);
      }
      return Response.json({ ok: true });
    }
    if (req.method === "POST") {
      const { model, input, output, cost: usd } = await req.json();
      for (const bucket of [total, (months[month()] ||= {})]) {
        const m = (bucket[model] ||= { requests: 0, input: 0, output: 0, cost: 0, priced: true });
        m.requests++;
        m.input += input;
        m.output += output;
        if (usd == null) m.priced = false;
        else m.cost += usd;
      }
      await this.storage.put("models", total);
      await this.storage.put("months", months);
    }
    return Response.json({ total, months });
  }

  // Fires at expiry to wipe the real key, then again at the end of retention to drop the record.
  async alarm() {
    const { id, expires } = (await this.storage.get("key")) || {};
    if (!id) return;
    const purge = Date.parse(expires) + RETAIN;
    if (Date.now() >= purge) return void (await this.wipe());
    const route = await this.env.KEYS.get(id, "json");
    if (route?.key) await this.env.KEYS.put(id, JSON.stringify({ ...route, key: null }), { expiration: Math.floor(purge / 1000) });
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
        cost: cost(model, usage, await prices(env)),
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

const authHeader = (route) => {
  const style = route.auth || "bearer";
  return style === "bearer" ? ["authorization", `Bearer ${route.key}`] : [style, route.key];
};

// Returns { bits, n } for an IPv4 or IPv6 address, or null when the text is not one.
export function parseIp(s) {
  s = String(s).trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const parts = s.split(".").map(Number);
    return parts.every((x) => x <= 255) ? { bits: 32, n: parts.reduce((a, x) => (a << 8n) | BigInt(x), 0n) } : null;
  }
  const halves = s.split("::");
  if (!s.includes(":") || halves.length > 2) return null;
  const [head, tail] = halves.map((h) => (h ? h.split(":") : []));
  const last = tail || head;
  if (last.at(-1)?.includes(".")) {
    const v4 = parseIp(last.pop());
    if (v4?.bits !== 32) return null;
    last.push((v4.n >> 16n).toString(16), (v4.n & 0xffffn).toString(16));
  }
  const groups = tail ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return { bits: 128, n: groups.reduce((a, g) => (a << 16n) | BigInt("0x" + g), 0n) };
}

function parseRange(range) {
  const [addr, len, extra] = String(range).trim().split("/");
  const ip = parseIp(addr);
  const bits = len === undefined ? ip?.bits : Number(len);
  if (!ip || extra !== undefined || !Number.isInteger(bits) || bits < 0 || bits > ip.bits) return null;
  return { ...ip, len: bits };
}

export function inRange(addr, range) {
  const ip = parseIp(addr);
  const r = parseRange(range);
  if (!ip || !r || ip.bits !== r.bits) return false;
  const shift = BigInt(r.bits - r.len);
  return ip.n >> shift === r.n >> shift;
}

async function proxy(req, env, url, ctx) {
  if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }), req);
  const h = req.headers;
  // Gemini clients may send the key as ?key=, which must not travel on to the provider.
  const query = new URLSearchParams(url.search);
  const queryKey = query.get("key");
  query.delete("key");
  const search = queryKey === null ? url.search : query.size ? "?" + query : "";
  const presented = h.get("authorization")?.replace(/^Bearer\s+/i, "") || h.get("x-api-key") || h.get("api-key") || h.get("x-goog-api-key") || queryKey || "";
  // Only well-formed ids reach KV, so random tokens cannot burn the daily KV read quota.
  const route = KEY_ID.test(presented) ? await env.KEYS.get(presented, "json") : null;
  if (!route?.key || !(Date.now() < Date.parse(route.expires))) return cors(json(401, "invalid or expired key"), req);

  if (route.ips?.length) {
    const ip = h.get("cf-connecting-ip") || "";
    if (!route.ips.some((r) => inRange(ip, r))) return cors(json(403, `this key cannot be used from ${ip || "an unknown address"}`), req);
  }

  // Clients use <gateway>/v1; the stored base is the provider's own base URL, which may end in /v1, /v4 or nothing.
  const path = url.pathname.replace(/^\/v1(?=\/|$)/, "");
  let body = req.body;
  if (req.method === "POST" && (route.models?.length || route.maxOutput)) {
    // Bytes, not text, so non-JSON uploads such as audio pass through unchanged.
    body = await req.arrayBuffer();
    let parsed;
    try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch {}
    // Gemini's native API names the model in the path: /models/<name>:generateContent.
    const model = parsed?.model ?? path.match(/\/models\/([^/:]+)/)?.[1];
    if (route.models?.length && !allowed(route.models, model) && !allowed(route.models, "models/" + model)) {
      return cors(json(403, `model ${model ?? "(none)"} is not allowed for this key`), req);
    }
    if (route.maxOutput && parsed && typeof parsed === "object") {
      const present = OUTPUT_FIELDS.filter((f) => typeof parsed[f] === "number");
      for (const f of present) parsed[f] = Math.min(parsed[f], route.maxOutput);
      if (!present.length && path === "/responses") parsed.max_output_tokens = route.maxOutput;
      else if (!present.length && (path === "/chat/completions" || path === "/completions")) parsed.max_tokens = route.maxOutput;
      body = JSON.stringify(parsed);
    }
  }
  if (route.capUsd || route.capTokens || route.rpm) {
    const { capUsd, capTokens, period, rpm } = route;
    const verdict = await meter(env, presented, "/admit", { method: "POST", body: JSON.stringify({ capUsd, capTokens, period, rpm }) });
    if (!verdict.ok) return cors(verdict, req);
  }

  const headers = new Headers();
  for (const [k, v] of h) if (!STRIP.test(k)) headers.set(k, v);
  headers.set(...authHeader(route));
  try {
    // A followed redirect would carry the real key to whatever host the provider names.
    const res = await fetch(route.base + path + search, { method: req.method, headers, body, redirect: "manual" });
    if (ctx && req.method === "POST" && METERED.has(path) && res.ok) ctx.waitUntil(record(env, presented, res.clone()));
    // Clients that list models only see the ones this key may use.
    if (route.models?.length && req.method === "GET" && path === "/models" && res.ok) {
      const data = await res.clone().json().catch(() => null);
      for (const k of ["data", "models"]) if (Array.isArray(data?.[k])) data[k] = data[k].filter((m) => allowed(route.models, m.id ?? m.name));
      if (data) return cors(Response.json(data), req);
    }
    return cors(res, req);
  } catch (err) {
    return cors(json(502, `upstream unreachable: ${err.message}`), req);
  }
}

// Validates every non-secret setting of a key.
function settings(s) {
  const { expires, auth = "bearer", label = "", models = [], ips = [], period = "total" } = s;
  const exp = Date.parse(expires);
  if (!(exp > Date.now() + 60e3)) return { error: "expiry must be at least a minute away" };
  if (!AUTH_STYLES.includes(auth)) return { error: `auth must be one of ${AUTH_STYLES.join(", ")}` };
  if (period !== "total" && period !== "month") return { error: "cap period must be total or month" };
  if (!Array.isArray(models) || models.length > 500 || !models.every((m) => typeof m === "string" && m && m.length <= 200)) {
    return { error: "models must be a list of up to 500 model names" };
  }
  if (!Array.isArray(ips) || ips.length > 100) return { error: "the IP allowlist must be a list of up to 100 entries" };
  const bad = ips.find((r) => !parseRange(r));
  if (bad !== undefined) return { error: `${bad} is not an IP address or CIDR range` };
  const out = { expires: new Date(exp).toISOString(), auth, label: String(label).slice(0, 100), models, ips: ips.map((r) => r.trim()), period };
  for (const [name, what] of Object.entries(LIMITS)) {
    if (s[name] == null || s[name] === "") continue;
    const n = Number(s[name]);
    const whole = name !== "capUsd";
    if (!(n > 0) || (whole && !Number.isInteger(n))) return { error: `${what} must be a positive ${whole ? "whole number" : "number"}` };
    out[name] = n;
  }
  return out;
}

async function save(env, id, route) {
  // Schedule the wipe first, so a stored real key always has one.
  await meter(env, id, "/schedule", { method: "POST", body: JSON.stringify({ id, expires: route.expires }) });
  await env.KEYS.put(id, JSON.stringify(route), { expiration: Math.floor((Date.parse(route.expires) + RETAIN) / 1000) });
  const { key, ...visible } = route;
  return Response.json({ id, ...visible });
}

function checkPrices(rows) {
  if (!Array.isArray(rows) || rows.length > 200) return "prices must be a list of up to 200 rows";
  const blank = (v) => v == null || v === "";
  for (const r of rows) {
    if (typeof r?.match !== "string" || !r.match.trim()) return "every price row needs a model name";
    if (!PRICE_FIELDS.every((f) => !blank(r[f]) && Number(r[f]) >= 0)) return `${r.match}: every rate must be a number of 0 or more`;
    if (!PRICE_OPTIONAL.every((f) => blank(r[f]) || Number(r[f]) > 0)) return `${r.match}: optional fields must be positive numbers`;
  }
  return null;
}

function tidyPrice(r) {
  const out = { match: r.match.trim() };
  for (const f of [...PRICE_FIELDS, ...PRICE_OPTIONAL]) if (r[f] != null && r[f] !== "") out[f] = Number(r[f]);
  return out;
}

const isJson = (req) => req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json";
const validBase = (b) => /^https:\/\/\S+$/.test(b || "");

async function admin(req, env, url) {
  if (!(await authorized(req, env))) {
    return new Response("login required", { status: 401, headers: { "www-authenticate": 'Basic realm="Key Router admin"' } });
  }
  if (url.pathname === "/admin") {
    return new Response(PAGE, {
      headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY" },
    });
  }
  // Writes require a JSON content type, which forces a CORS preflight, so other sites cannot use cached credentials.
  const body = isJson(req) ? await req.json().catch(() => ({})) : null;

  if (url.pathname === "/admin/keys" && req.method === "GET") {
    const names = [];
    let cursor;
    do {
      const page = await env.KEYS.list({ prefix: "sk-gw-", cursor });
      names.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    const keys = await Promise.all(names.map(async (id) => {
      const route = await env.KEYS.get(id, "json");
      if (!route) return null;
      const { key, ...visible } = route;
      return { id, ...visible, active: !!key && Date.now() < Date.parse(route.expires), usage: await (await meter(env, id, "/")).json() };
    }));
    return Response.json(keys.filter(Boolean));
  }

  if (url.pathname === "/admin/keys" && req.method === "POST" && body) {
    // A duplicate may reuse the real key of the key it copies, so the browser never needs it.
    const source = !body.key && KEY_ID.test(body.from || "") ? await env.KEYS.get(body.from, "json") : null;
    const key = body.key || source?.key;
    if (!validBase(body.base) || !key) return json(400, "need an https endpoint and an API key");
    const s = settings(body);
    if (s.error) return json(400, s.error);
    const id = "sk-gw-" + crypto.randomUUID().replaceAll("-", "");
    return save(env, id, { base: body.base.replace(/\/+$/, ""), key, ...s });
  }
  const usage = url.pathname.match(/^\/admin\/keys\/(sk-gw-[0-9a-f]{32})\/usage$/);
  if (usage && req.method === "DELETE") return meter(env, usage[1], "/reset", { method: "POST" });

  const match = url.pathname.match(/^\/admin\/keys\/(sk-gw-[0-9a-f]{32})$/);
  if (match && req.method === "PATCH" && body) {
    const route = await env.KEYS.get(match[1], "json");
    if (!route?.key || !(Date.now() < Date.parse(route.expires))) return json(404, "no active key with that id");
    if (body.base && !validBase(body.base)) return json(400, "the endpoint must be an https URL");
    const s = settings({ ...route, ...body });
    if (s.error) return json(400, s.error);
    return save(env, match[1], { base: body.base ? body.base.replace(/\/+$/, "") : route.base, key: body.key || route.key, ...s });
  }
  if (match && req.method === "DELETE") {
    await env.KEYS.delete(match[1]);
    await meter(env, match[1], "/", { method: "DELETE" });
    return Response.json({ ok: true });
  }

  // Lists a provider's models. Given an existing key id, the stored real key is used and never reaches the browser.
  if (url.pathname === "/admin/models" && req.method === "POST" && body) {
    const stored = KEY_ID.test(body.id || "") ? await env.KEYS.get(body.id, "json") : null;
    const route = body.key ? body : stored && { ...stored, ...(body.base && { base: body.base }), ...(body.auth && { auth: body.auth }) };
    if (!route?.key || !validBase(route.base)) return json(400, "need an https endpoint and an API key");
    const base = route.base.replace(/\/+$/, "");
    const anthropic = route.auth === "x-api-key";
    const headers = new Headers([authHeader(route)]);
    if (anthropic) headers.set("anthropic-version", "2023-06-01");
    let res;
    try {
      res = await fetch(base + "/models" + (anthropic ? "?limit=1000" : ""), { headers, redirect: "manual", signal: AbortSignal.timeout(15e3) });
    } catch (err) {
      return json(502, `could not reach ${base}: ${err.message}`);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      const why = data?.error?.message || (typeof data?.error === "string" && data.error) || `no model list at ${base}/models`;
      return json(502, `provider answered ${res.status}: ${why}`);
    }
    const list = data.data || data.models || (Array.isArray(data) ? data : []);
    const ids = list.map((m) => (typeof m === "string" ? m : m?.id ?? m?.name)).filter((m) => typeof m === "string");
    return Response.json({ models: [...new Set(ids)].sort() });
  }

  if (url.pathname === "/admin/prices" && req.method === "GET") {
    return Response.json({ prices: await prices(env), defaults: DEFAULT_PRICES });
  }
  if (url.pathname === "/admin/prices" && req.method === "PUT" && body) {
    const error = checkPrices(body.prices);
    if (error) return json(400, error);
    const rows = body.prices.map(tidyPrice);
    await env.KEYS.put("config:prices", JSON.stringify(rows));
    priceCache = { at: Date.now(), rows };
    return Response.json({ prices: rows });
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
