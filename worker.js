import ADMIN_PAGE from "./admin.html";
import LOGIN_PAGE from "./login.html";
import USAGE_PAGE from "./usage.html";
import SHARE_PAGE from "./share.html";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return admin(req, env, url);
    if (url.pathname === "/usage") return usage(req, env, url);
    const share = url.pathname.match(/^\/share\/([0-9a-f]{32})$/);
    if (share) return claimShare(req, env, url, share[1]);
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
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Workers Free allows 50 subrequests per request; each listed key costs one, each created key two.
const PAGE_SIZE = 20;
const BATCH_MAX = 20;
const SESSION_TTL = 12 * 3600e3;

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

const enc = (s) => new TextEncoder().encode(s);
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(String(s).replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
const randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (data) => new Uint8Array(await crypto.subtle.digest("SHA-256", data));

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
  return { input_tokens: total - cached, cache_read_input_tokens: cached, output_tokens: u.completion_tokens ?? u.output_tokens, cost: u.cost };
}

// Handles Anthropic Messages, OpenAI Chat Completions and OpenAI Responses bodies, streamed or not.
function extract(text, type) {
  // Only events carrying a usage object are parsed: a long stream parsed in full would exceed the free plan's 10 ms of CPU.
  const chunks = type?.includes("event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:") && /"usage"\s*:\s*\{/.test(l)).map((l) => l.slice(5))
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
const usedIn = (u, period) => sum(period === "month" ? u.months?.[month()] : u.total);

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
      const used = usedIn({ total, months }, period);
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
      return Response.json({ ok: true, used: Math.max(capUsd ? used.usd / capUsd : 0, capTokens ? used.tokens / capTokens : 0) });
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
    const { value, metadata } = await this.env.KEYS.getWithMetadata(id, "json");
    if (value?.key) {
      await this.env.KEYS.put(id, JSON.stringify({ ...value, key: null }), { expiration: Math.floor(purge / 1000), metadata: { ...metadata, expired: true } });
    }
    await this.storage.setAlarm(purge);
  }

  async wipe() {
    await this.storage.deleteAlarm();
    await this.storage.deleteAll();
    return { ok: true };
  }
}

// A single Durable Object for admin sign-in and share links, whose single-use checks must not race.
export class Admin {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = req.method === "POST" ? await req.json() : {};
    if (path === "/share/create") {
      const shares = await this.live("shares");
      const token = randomHex(16);
      shares[token] = { id: body.id, exp: body.exp };
      await this.storage.put("shares", shares);
      return Response.json({ token });
    }
    if (path === "/share/claim") {
      const shares = await this.live("shares");
      const share = Object.hasOwn(shares, body.token) ? shares[body.token] : null;
      delete shares[body.token];
      await this.storage.put("shares", shares);
      return Response.json(share);
    }
    if (path === "/challenge") {
      // Anyone can ask for a sign-in challenge, so only the newest few are kept.
      const recent = Object.entries(await this.live("challenges")).sort((a, b) => b[1].exp - a[1].exp).slice(0, 19);
      const challenge = b64u(crypto.getRandomValues(new Uint8Array(32)));
      await this.storage.put("challenges", { ...Object.fromEntries(recent), [challenge]: { exp: Date.now() + 5 * 60e3 } });
      return Response.json({ challenge });
    }
    if (path === "/consume") {
      const challenges = await this.live("challenges");
      const ok = Object.hasOwn(challenges, body.challenge);
      delete challenges[body.challenge];
      await this.storage.put("challenges", challenges);
      return Response.json({ ok });
    }
    if (path === "/passkeys") {
      let passkeys = (await this.storage.get("passkeys")) || [];
      if (body.add) passkeys = [...passkeys.filter((p) => p.id !== body.add.id), body.add];
      if (body.remove) passkeys = passkeys.filter((p) => p.id !== body.remove);
      if (body.add || body.remove) await this.storage.put("passkeys", passkeys);
      return Response.json(passkeys);
    }
    if (path === "/session-key") {
      let key = await this.storage.get("sessionKey");
      if (!key) await this.storage.put("sessionKey", (key = b64u(crypto.getRandomValues(new Uint8Array(32)))));
      return Response.json({ key });
    }
    return json(404, "not found");
  }

  async live(name) {
    const all = (await this.storage.get(name)) || {};
    return Object.fromEntries(Object.entries(all).filter(([, v]) => v.exp > Date.now()));
  }
}

const meter = (env, id, path, init) => env.METER.get(env.METER.idFromName(id)).fetch("https://meter" + path, init);
const adminStore = (env, path, body) =>
  env.ADMIN.get(env.ADMIN.idFromName("admin")).fetch("https://admin" + path, body && { method: "POST", body: JSON.stringify(body) });

// Real keys are encrypted with ENCRYPTION_KEY and bound to their gateway id, so a copied KV value is useless alone.
const sealKeys = new Map();
function sealKey(secret) {
  if (!sealKeys.has(secret)) {
    sealKeys.set(secret, sha256(enc(secret)).then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"])));
  }
  return sealKeys.get(secret);
}

async function seal(env, id, plain) {
  if (!env.ENCRYPTION_KEY || plain == null) return plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc(id) }, await sealKey(env.ENCRYPTION_KEY), enc(plain));
  return `enc:v1:${b64u(iv)}:${b64u(data)}`;
}

async function unseal(env, id, stored) {
  if (typeof stored !== "string" || !stored.startsWith("enc:v1:")) return stored;
  const [, , iv, data] = stored.split(":");
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv), additionalData: enc(id) }, await sealKey(env.ENCRYPTION_KEY || ""), unb64u(data));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

async function record(env, id, res, base) {
  try {
    const { model, usage } = extract(await res.text(), res.headers.get("content-type"));
    if (!model || !Object.keys(usage).length) return;
    // OpenRouter reports what it actually charged, which beats any list price.
    const charged = /^https:\/\/openrouter\.ai\//.test(base) && typeof usage.cost === "number" ? usage.cost : null;
    await meter(env, id, "/", {
      method: "POST",
      body: JSON.stringify({
        model,
        input: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
        output: usage.output_tokens || 0,
        cost: charged ?? cost(model, usage, await prices(env)),
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

const authHeader = (style = "bearer", key) => (style === "bearer" ? ["authorization", `Bearer ${key}`] : [style, key]);

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

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

// True when the date falls inside the key's weekly window. A window ending before it starts runs past midnight
// and belongs to the day it starts on.
export function withinHours(hours, date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: hours.tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(date).map((p) => [p.type, p.value]));
  const day = DAYS.indexOf(parts.weekday);
  const now = Number(parts.hour) * 60 + Number(parts.minute);
  const [start, end] = [minutes(hours.start), minutes(hours.end)];
  if (start === end) return hours.days.includes(day);
  if (start < end) return hours.days.includes(day) && now >= start && now < end;
  return (hours.days.includes(day) && now >= start) || (hours.days.includes((day + 6) % 7) && now < end);
}

function presentedKey(req, url) {
  const h = req.headers;
  // Gemini clients may send the key as ?key=, which must not travel on to the provider.
  const query = new URLSearchParams(url.search);
  const queryKey = query.get("key");
  query.delete("key");
  const search = queryKey === null ? url.search : query.size ? "?" + query : "";
  const presented = h.get("authorization")?.replace(/^Bearer\s+/i, "") || h.get("x-api-key") || h.get("api-key") || h.get("x-goog-api-key") || queryKey || "";
  return { presented, search };
}

async function proxy(req, env, url, ctx) {
  if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }), req);
  const { presented, search } = presentedKey(req, url);
  // Only well-formed ids reach KV, so random tokens cannot burn the daily KV read quota.
  const route = KEY_ID.test(presented) ? await env.KEYS.get(presented, "json") : null;
  if (!route?.key || !(Date.now() < Date.parse(route.expires))) return cors(json(401, "invalid or expired key"), req);

  if (route.ips?.length) {
    const ip = req.headers.get("cf-connecting-ip") || "";
    if (!route.ips.some((r) => inRange(ip, r))) return cors(json(403, `this key cannot be used from ${ip || "an unknown address"}`), req);
  }
  if (route.hours && !withinHours(route.hours, new Date(Date.now()))) {
    const { days, start, end, tz } = route.hours;
    return cors(json(403, `this key only works ${days.map((d) => DAYS[d]).join(", ")} ${start}-${end} (${tz})`), req);
  }
  const realKey = await unseal(env, presented, route.key);
  if (!realKey) return cors(json(500, "the stored provider key cannot be decrypted; check ENCRYPTION_KEY"), req);

  // Clients use <gateway>/v1; the stored base is the provider's own base URL, which may end in /v1, /v4 or nothing.
  const path = url.pathname.replace(/^\/v1(?=\/|$)/, "");
  let body = req.body;
  let parsed;
  if (req.method === "POST" && (route.models?.length || route.maxOutput || route.downgrade || path === "/chat/completions")) {
    // Bytes, not text, so non-JSON uploads such as audio pass through unchanged.
    body = await req.arrayBuffer();
    try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch {}
    if (typeof parsed !== "object" || parsed === null) parsed = undefined;
    // Gemini's native API names the model in the path: /models/<name>:generateContent.
    const model = parsed?.model ?? path.match(/\/models\/([^/:]+)/)?.[1];
    if (route.models?.length && !allowed(route.models, model) && !allowed(route.models, "models/" + model)) {
      return cors(json(403, `model ${model ?? "(none)"} is not allowed for this key`), req);
    }
  }
  let changed = false;
  let downgraded;
  if (route.capUsd || route.capTokens || route.rpm) {
    const { capUsd, capTokens, period, rpm } = route;
    const verdict = await meter(env, presented, "/admit", { method: "POST", body: JSON.stringify({ capUsd, capTokens, period, rpm }) });
    if (!verdict.ok) return cors(verdict, req);
    const { used } = await verdict.json();
    // Requests already running keep their model; only requests starting past the threshold are rerouted.
    const rule = route.downgrade && used >= route.downgrade.at / 100 && route.downgrade.map.find(([from]) => allowed([from], parsed?.model));
    if (rule) {
      downgraded = `${parsed.model} -> ${rule[1]}`;
      parsed.model = rule[1];
      changed = true;
    }
  }
  if (route.maxOutput && parsed) {
    const present = OUTPUT_FIELDS.filter((f) => typeof parsed[f] === "number");
    for (const f of present) parsed[f] = Math.min(parsed[f], route.maxOutput);
    if (!present.length && path === "/responses") parsed.max_output_tokens = route.maxOutput;
    else if (!present.length && (path === "/chat/completions" || path === "/completions")) parsed.max_tokens = route.maxOutput;
    else if (/:(stream)?generateContent$/.test(path)) {
      const g = (parsed.generationConfig ||= {});
      g.maxOutputTokens = Math.min(typeof g.maxOutputTokens === "number" ? g.maxOutputTokens : Infinity, route.maxOutput);
    }
    changed = true;
  }
  // OpenAI-style streams carry no token counts unless asked, and an unmetered call would slip past every cap.
  if (path === "/chat/completions" && parsed?.stream === true && parsed.stream_options?.include_usage !== true) {
    parsed.stream_options = { ...parsed.stream_options, include_usage: true };
    changed = true;
  }
  if (changed) body = JSON.stringify(parsed);

  const headers = new Headers();
  for (const [k, v] of req.headers) if (!STRIP.test(k)) headers.set(k, v);
  headers.set(...authHeader(route.auth, realKey));
  try {
    // A followed redirect would carry the real key to whatever host the provider names.
    const res = await fetch(route.base + path + search, { method: req.method, headers, body, redirect: "manual" });
    if (ctx && req.method === "POST" && METERED.has(path) && res.ok) ctx.waitUntil(record(env, presented, res.clone(), route.base));
    let out = cors(res, req);
    // Clients that list models only see the ones this key may use.
    if (route.models?.length && req.method === "GET" && path === "/models" && res.ok) {
      const data = await res.clone().json().catch(() => null);
      for (const k of ["data", "models"]) if (Array.isArray(data?.[k])) data[k] = data[k].filter((m) => allowed(route.models, m.id ?? m.name));
      if (data) out = cors(Response.json(data), req);
    }
    if (downgraded) out.headers.set("x-gateway-downgrade", downgraded);
    return out;
  } catch (err) {
    return cors(json(502, `upstream unreachable: ${err.message}`), req);
  }
}

// Lets a key holder check their own budget, either as JSON (with the key) or through a small page (without).
async function usage(req, env, url) {
  if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }), req);
  const { presented } = presentedKey(req, url);
  if (!presented) return page(USAGE_PAGE);
  const route = KEY_ID.test(presented) ? await env.KEYS.get(presented, "json") : null;
  if (!route) return cors(json(401, "invalid key"), req);
  const used = usedIn(await (await meter(env, presented, "/")).json(), route.period);
  const { capUsd = null, capTokens = null, rpm = null, maxOutput = null, period = "total" } = route;
  return cors(Response.json({
    label: route.label || "",
    active: !!route.key && Date.now() < Date.parse(route.expires),
    expires: route.expires,
    period,
    used,
    remaining: { usd: capUsd && Math.max(0, capUsd - used.usd), tokens: capTokens && Math.max(0, capTokens - used.tokens) },
    limits: { capUsd, capTokens, rpm, maxOutput },
    models: route.models || [],
    hours: route.hours || null,
    downgrade: route.downgrade ? { at: route.downgrade.at, map: route.downgrade.map } : null,
  }, { headers: { "cache-control": "no-store" } }), req);
}

async function claimShare(req, env, url, token) {
  if (req.method === "GET") return page(SHARE_PAGE);
  if (req.method !== "POST") return json(405, "use POST to reveal the key");
  const share = await (await adminStore(env, "/share/claim", { token })).json();
  const route = share && (await env.KEYS.get(share.id, "json"));
  if (!route?.key || !(Date.now() < Date.parse(route.expires))) return json(410, "this link was already used, has expired, or its key was revoked");
  return Response.json(
    { key: share.id, endpoint: url.origin + "/v1", origin: url.origin, label: route.label || "", expires: route.expires, models: route.models || [] },
    { headers: { "cache-control": "no-store" } },
  );
}

// Validates every non-secret setting of a key.
function settings(s) {
  const { expires, auth = "bearer", label = "", models = [], ips = [], period = "total", hours = null, downgrade = null } = s;
  const exp = Date.parse(expires);
  if (!(exp > Date.now() + 60e3)) return { error: "expiry must be at least a minute away" };
  if (!AUTH_STYLES.includes(auth)) return { error: `auth must be one of ${AUTH_STYLES.join(", ")}` };
  if (period !== "total" && period !== "month") return { error: "cap period must be total or month" };
  const names = (list, max) => Array.isArray(list) && list.length <= max && list.every((m) => typeof m === "string" && m && m.length <= 200);
  if (!names(models, 500)) return { error: "models must be a list of up to 500 model names" };
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
  if (hours) {
    const time = /^([01]\d|2[0-3]):[0-5]\d$/;
    const { days, start, end, tz } = hours;
    if (!Array.isArray(days) || !days.length || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return { error: "pick at least one day for the time window" };
    if (!time.test(start) || !time.test(end)) return { error: "time window start and end must be HH:MM" };
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { return { error: `${tz} is not a time zone` }; }
    out.hours = { days: [...new Set(days)].sort(), start, end, tz };
  }
  if (downgrade) {
    const { at, map } = downgrade;
    if (!out.capUsd && !out.capTokens) return { error: "a downgrade needs a spend or token cap to measure against" };
    if (!(Number(at) > 0 && Number(at) <= 100)) return { error: "the downgrade threshold must be a percentage from 1 to 100" };
    if (!Array.isArray(map) || !map.length || map.length > 50 || !map.every((p) => names(p, 2) && p.length === 2)) {
      return { error: "downgrade rules must be pairs of model names" };
    }
    out.downgrade = { at: Number(at), map };
  }
  return out;
}

function limitsText(k) {
  const per = k.period === "month" ? " per month" : "";
  const models = k.models || [];
  const n = (x) => x.toLocaleString("en-US");
  return [
    k.auth && k.auth !== "bearer" ? "header " + k.auth : "",
    k.capUsd ? `cap $${k.capUsd}${per}` : "",
    k.capTokens ? `cap ${n(k.capTokens)} tokens${per}` : "",
    k.downgrade ? `past ${k.downgrade.at}%: ` + k.downgrade.map.map(([a, b]) => `${a} -> ${b}`).join(", ") : "",
    k.rpm ? `${k.rpm} requests/min` : "",
    k.maxOutput ? `max ${n(k.maxOutput)} output tokens` : "",
    models.length ? "models: " + (models.length > 3 ? models.slice(0, 3).join(", ") + ` +${models.length - 3} more` : models.join(", ")) : "",
    k.ips?.length ? "IPs: " + k.ips.join(", ") : "",
    k.hours ? `${k.hours.days.map((d) => DAYS[d]).join(" ")} ${k.hours.start}-${k.hours.end} ${k.hours.tz}` : "",
  ].filter(Boolean).join("\n") || "none";
}

// The listing reads KV metadata only, which is capped at 1024 bytes, so it holds a summary of the settings.
function summary(route) {
  const meta = { base: route.base, expires: route.expires, label: route.label };
  let limits = limitsText(route);
  while (JSON.stringify({ ...meta, limits }).length > 1000) limits = limits.slice(0, -20);
  return { ...meta, limits };
}

async function save(env, id, route) {
  // Schedule the wipe first, so a stored real key always has one.
  await meter(env, id, "/schedule", { method: "POST", body: JSON.stringify({ id, expires: route.expires }) });
  const { key, ...visible } = route;
  await env.KEYS.put(id, JSON.stringify(route), { expiration: Math.floor((Date.parse(route.expires) + RETAIN) / 1000), metadata: summary(visible) });
  return { id, ...visible };
}

function checkPrices(rows) {
  if (!Array.isArray(rows) || rows.length > 2000) return "prices must be a list of up to 2000 rows";
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

// OpenRouter lists USD per token as strings; rows here are USD per million tokens.
async function openRouterPrices() {
  const res = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(15e3) }).catch(() => null);
  const data = await res?.json().catch(() => null);
  if (!res?.ok || !Array.isArray(data?.data)) return null;
  const perMillion = (v) => {
    const n = Number(v);
    return v != null && v !== "" && Number.isFinite(n) && n >= 0 ? Math.round(n * 1e12) / 1e6 : null;
  };
  return data.data.flatMap((m) => {
    const p = m.pricing || {};
    const [inp, out] = [perMillion(p.prompt), perMillion(p.completion)];
    if (typeof m.id !== "string" || inp == null || out == null) return [];
    const write = perMillion(p.input_cache_write) ?? inp;
    return [{ match: m.id, in: inp, out, read: perMillion(p.input_cache_read) ?? inp, write5m: write, write1h: write }];
  });
}

const page = (html) => new Response(html, {
  headers: {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "frame-ancestors 'none'",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  },
});
const isJson = (req) => req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json";
const validBase = (b) => /^https:\/\/\S+$/.test(b || "") && b.length <= 300;
const newId = () => "sk-gw-" + randomHex(16);

// Sessions are HMAC-signed expiry times; the signing key lives in the Admin Durable Object.
let sessionKeyCache = null;
function sessionKey(env) {
  sessionKeyCache ||= adminStore(env, "/session-key")
    .then((r) => r.json())
    .then(({ key }) => crypto.subtle.importKey("raw", unb64u(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]))
    .catch((err) => {
      sessionKeyCache = null;
      throw err;
    });
  return sessionKeyCache;
}

async function newSession(env) {
  const exp = String(Date.now() + SESSION_TTL);
  const sig = b64u(await crypto.subtle.sign("HMAC", await sessionKey(env), enc(exp)));
  return `kr_session=${exp}.${sig}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`;
}

async function validSession(req, env) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)kr_session=(\d+)\.([\w-]+)/);
  if (!m || Number(m[1]) < Date.now()) return false;
  try {
    return await crypto.subtle.verify("HMAC", await sessionKey(env), unb64u(m[2]), enc(m[1]));
  } catch {
    return false;
  }
}

const passkeys = async (env) => (await adminStore(env, "/passkeys", {})).json();

// WebAuthn algorithm ids: ES256, Ed25519 and RS256.
const ALGS = {
  "-7": [{ name: "ECDSA", namedCurve: "P-256" }, { name: "ECDSA", hash: "SHA-256" }],
  "-8": [{ name: "Ed25519" }, { name: "Ed25519" }],
  "-257": [{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, { name: "RSASSA-PKCS1-v1_5" }],
};

// WebAuthn ECDSA signatures are DER sequences; WebCrypto wants the raw 64-byte r||s form.
function derToRaw(der) {
  let i = 2;
  const part = () => {
    if (der[i++] !== 2) throw new Error("bad signature");
    const v = der.slice(i + 1, (i += 1 + der[i]));
    const out = new Uint8Array(32);
    out.set(v.slice(Math.max(0, v.length - 32)), 32 - Math.min(32, v.length));
    return out;
  };
  return new Uint8Array([...part(), ...part()]);
}

async function clientData(env, url, encoded, type) {
  const raw = unb64u(encoded);
  const data = JSON.parse(new TextDecoder().decode(raw));
  if (data.type !== type || data.origin !== url.origin) return null;
  return (await (await adminStore(env, "/consume", { challenge: data.challenge })).json()).ok ? raw : null;
}

async function verifyAssertion(env, url, cred, a) {
  try {
    const raw = await clientData(env, url, a.clientDataJSON, "webauthn.get");
    const auth = unb64u(a.authenticatorData);
    const rpHash = await sha256(enc(url.hostname));
    // Flag bit 0 is user presence and bit 2 is user verification; both are required.
    if (!raw || !rpHash.every((b, i) => b === auth[i]) || (auth[32] & 5) !== 5) return false;
    const [importAlg, verifyAlg] = ALGS[cred.alg];
    const key = await crypto.subtle.importKey("spki", unb64u(cred.publicKey), importAlg, false, ["verify"]);
    const sig = cred.alg === -7 ? derToRaw(unb64u(a.signature)) : unb64u(a.signature);
    return await crypto.subtle.verify(verifyAlg, key, sig, new Uint8Array([...auth, ...(await sha256(raw))]));
  } catch {
    return false;
  }
}

async function admin(req, env, url) {
  // Writes require a JSON content type, which forces a CORS preflight, so other sites cannot use stored credentials.
  const body = isJson(req) ? await req.json().catch(() => ({})) : null;
  const path = url.pathname;

  if (path === "/admin/login/options" && req.method === "POST") {
    return Response.json({ ...(await (await adminStore(env, "/challenge", {})).json()), rpId: url.hostname });
  }
  if (path === "/admin/login" && req.method === "POST" && body) {
    const cred = (await passkeys(env)).find((p) => p.id === body.id);
    if (!cred || !(await verifyAssertion(env, url, cred, body))) return json(401, "passkey sign-in failed");
    return Response.json({ ok: true }, { headers: { "set-cookie": await newSession(env) } });
  }
  if (path === "/admin/logout" && req.method === "POST") {
    return Response.json({ ok: true }, { headers: { "set-cookie": "kr_session=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0" } });
  }

  if (!(await validSession(req, env))) {
    // The password works until a passkey exists; ALLOW_PASSWORD=true brings it back if every passkey is lost.
    const passwordAllowed = env.ALLOW_PASSWORD === "true" || !(await passkeys(env)).length;
    if (!passwordAllowed) return path === "/admin" ? page(LOGIN_PAGE) : json(401, "sign in with a passkey");
    if (!(await passwordOk(req, env))) {
      return new Response("login required", { status: 401, headers: { "www-authenticate": 'Basic realm="Key Router admin"' } });
    }
  }
  if (path === "/admin") return page(ADMIN_PAGE);

  if (path === "/admin/status" && req.method === "GET") {
    return Response.json({ encrypted: !!env.ENCRYPTION_KEY, passkeys: (await passkeys(env)).length, passwordFallback: env.ALLOW_PASSWORD === "true" });
  }

  if (path === "/admin/keys" && req.method === "GET") {
    const list = await env.KEYS.list({ prefix: "sk-gw-", cursor: url.searchParams.get("cursor") || undefined, limit: PAGE_SIZE });
    const keys = await Promise.all(list.keys.map(async (k) => ({
      id: k.name,
      ...k.metadata,
      active: !k.metadata?.expired && Date.now() < Date.parse(k.metadata?.expires),
      usage: await (await meter(env, k.name, "/")).json(),
    })));
    return Response.json({ keys, cursor: list.list_complete ? null : list.cursor });
  }

  if (path === "/admin/keys" && req.method === "POST" && body) {
    // A duplicate may reuse the real key of the key it copies, so the browser never needs it.
    const source = !body.key && KEY_ID.test(body.from || "") ? await env.KEYS.get(body.from, "json") : null;
    const plain = body.key || (source && (await unseal(env, body.from, source.key)));
    if (!validBase(body.base) || !plain) return json(400, "need an https endpoint and an API key");
    const count = body.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > BATCH_MAX) return json(400, `you can create 1 to ${BATCH_MAX} keys at once`);
    const s = settings(body);
    if (s.error) return json(400, s.error);
    const made = [];
    for (let i = 1; i <= count; i++) {
      const id = newId();
      const label = count > 1 ? `${s.label || "key"} ${i}` : s.label;
      made.push(await save(env, id, { base: body.base.replace(/\/+$/, ""), key: await seal(env, id, plain), ...s, label }));
    }
    return Response.json(count > 1 ? { keys: made } : made[0]);
  }

  const one = path.match(/^\/admin\/keys\/(sk-gw-[0-9a-f]{32})(\/usage|\/share)?$/);
  const id = one?.[1];
  if (one && !one[2] && req.method === "GET") {
    const route = await env.KEYS.get(id, "json");
    if (!route) return json(404, "no key with that id");
    const { key, ...visible } = route;
    return Response.json({ id, ...visible, active: !!key && Date.now() < Date.parse(route.expires), usage: await (await meter(env, id, "/")).json() });
  }
  if (one && !one[2] && req.method === "PATCH" && body) {
    const route = await env.KEYS.get(id, "json");
    if (!route?.key || !(Date.now() < Date.parse(route.expires))) return json(404, "no active key with that id");
    if (body.base && !validBase(body.base)) return json(400, "the endpoint must be an https URL");
    const plain = body.key || (await unseal(env, id, route.key));
    if (!plain) return json(400, "the stored key cannot be decrypted; enter the real key again");
    const s = settings({ ...route, ...body });
    if (s.error) return json(400, s.error);
    return Response.json(await save(env, id, { base: body.base ? body.base.replace(/\/+$/, "") : route.base, key: await seal(env, id, plain), ...s }));
  }
  if (one && !one[2] && req.method === "DELETE") {
    await env.KEYS.delete(id);
    await meter(env, id, "/", { method: "DELETE" });
    return Response.json({ ok: true });
  }
  if (one?.[2] === "/usage" && req.method === "DELETE") return meter(env, id, "/reset", { method: "POST" });
  if (one?.[2] === "/share" && req.method === "POST" && body) {
    const route = await env.KEYS.get(id, "json");
    if (!route?.key || !(Date.now() < Date.parse(route.expires))) return json(404, "no active key with that id");
    const exp = Math.min(Date.now() + 864e5, Date.parse(route.expires));
    const { token } = await (await adminStore(env, "/share/create", { id, exp })).json();
    return Response.json({ url: `${url.origin}/share/${token}`, expires: new Date(exp).toISOString() });
  }

  // Lists a provider's models. Given an existing key id, the stored real key is used and never reaches the browser.
  if (path === "/admin/models" && req.method === "POST" && body) {
    const stored = KEY_ID.test(body.id || "") ? await env.KEYS.get(body.id, "json") : null;
    const route = body.key ? body : stored && { ...stored, key: await unseal(env, body.id, stored.key), ...(body.base && { base: body.base }), ...(body.auth && { auth: body.auth }) };
    if (!route?.key || !validBase(route.base)) return json(400, "need an https endpoint and an API key");
    const base = route.base.replace(/\/+$/, "");
    const anthropic = route.auth === "x-api-key";
    const headers = new Headers([authHeader(route.auth, route.key)]);
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

  if (path === "/admin/prices" && req.method === "GET") return Response.json({ prices: await prices(env), defaults: DEFAULT_PRICES });
  if (path === "/admin/prices/openrouter" && req.method === "GET") {
    const rows = await openRouterPrices();
    return rows ? Response.json({ prices: rows }) : json(502, "could not read OpenRouter's model list");
  }
  if (path === "/admin/prices" && req.method === "PUT" && body) {
    const error = checkPrices(body.prices);
    if (error) return json(400, error);
    const rows = body.prices.map(tidyPrice);
    await env.KEYS.put("config:prices", JSON.stringify(rows));
    priceCache = { at: Date.now(), rows };
    return Response.json({ prices: rows });
  }

  if (path === "/admin/passkeys" && req.method === "GET") {
    return Response.json((await passkeys(env)).map(({ id, name, created }) => ({ id, name, created })));
  }
  if (path === "/admin/passkeys/options" && req.method === "POST" && body) {
    const { challenge } = await (await adminStore(env, "/challenge", {})).json();
    return Response.json({ challenge, rp: { id: url.hostname, name: "Key Router" }, exclude: (await passkeys(env)).map((p) => p.id) });
  }
  if (path === "/admin/passkeys" && req.method === "POST" && body) {
    const alg = Number(body.alg);
    if (!ALGS[alg] || !/^[\w-]{16,1400}$/.test(body.id || "")) return json(400, "this passkey type is not supported");
    try {
      if (!(await clientData(env, url, body.clientDataJSON, "webauthn.create"))) return json(400, "passkey registration expired or came from another site");
      await crypto.subtle.importKey("spki", unb64u(body.publicKey), ALGS[alg][0], false, ["verify"]);
    } catch {
      return json(400, "the passkey's public key could not be read");
    }
    const name = String(body.name || "Passkey").slice(0, 60);
    await adminStore(env, "/passkeys", { add: { id: body.id, publicKey: body.publicKey, alg, name, created: new Date().toISOString() } });
    // The password stops working once a passkey exists, so the current browser gets a session right away.
    return Response.json({ ok: true }, { headers: { "set-cookie": await newSession(env) } });
  }
  const pk = path.match(/^\/admin\/passkeys\/([\w-]{16,1400})$/);
  if (pk && req.method === "DELETE") {
    await adminStore(env, "/passkeys", { remove: pk[1] });
    return Response.json({ ok: true });
  }
  return json(404, "not found");
}

async function passwordOk(req, env) {
  const [scheme, encoded] = (req.headers.get("authorization") || "").split(" ");
  if (scheme !== "Basic" || !encoded || !env.ADMIN_PASSWORD) return false;
  let password;
  try {
    password = atob(encoded).split(":").slice(1).join(":");
  } catch {
    return false;
  }
  const a = enc(password);
  const b = enc(env.ADMIN_PASSWORD);
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}

function json(status, message) {
  return Response.json({ error: { message } }, { status });
}
