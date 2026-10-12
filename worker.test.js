import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

// Workers-only API.
crypto.subtle.timingSafeEqual = timingSafeEqual;

// Wrangler bundles .html as a text module; mirror that for Node.
registerHooks({
  load(url, context, next) {
    if (url.endsWith(".html")) return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))};` };
    return next(url, context);
  },
});
const { default: worker, Meter, Admin, cost, inRange, parseIp, withinHours, DEFAULT_PRICES } = await import("./worker.js");

const store = new Map();
// Durable Object namespace stand-in: one instance per name, each with in-memory storage and an alarm slot.
function namespace(Class) {
  const instances = new Map();
  return {
    idFromName: (name) => name,
    get(name) {
      if (!instances.has(name)) {
        const data = new Map();
        const storage = {
          alarmAt: null,
          get: async (k) => data.get(k),
          put: async (k, v) => void data.set(k, v),
          deleteAll: async () => data.clear(),
          delete: async (keys) => keys.forEach((k) => data.delete(k)),
          setAlarm: async (t) => void (storage.alarmAt = t),
          deleteAlarm: async () => void (storage.alarmAt = null),
        };
        const meter = new Class({ storage }, env);
        instances.set(name, { meter, storage, fetch: (url, init) => meter.fetch(new Request(url, init)) });
      }
      return instances.get(name);
    },
  };
}
const env = {
  ADMIN_PASSWORD: "pw",
  ENCRYPTION_KEY: "test-encryption-secret",
  KEYS: {
    async get(k) { return store.has(k) ? JSON.parse(store.get(k).value) : null; },
    async getWithMetadata(k) { return { value: await this.get(k), metadata: store.get(k)?.metadata ?? null }; },
    async put(k, value, opts) { store.set(k, { value, ...opts }); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "", cursor = "0", limit = 1000 } = {}) {
      const all = [...store].filter(([name]) => name.startsWith(prefix));
      const at = Number(cursor);
      const keys = all.slice(at, at + limit).map(([name, v]) => ({ name, metadata: v.metadata }));
      return at + limit >= all.length ? { keys, list_complete: true } : { keys, list_complete: false, cursor: String(at + limit) };
    },
  },
};
env.METER = namespace(Meter);
env.ADMIN = namespace(Admin);

let sent;
globalThis.fetch = async (url, init) => {
  sent = { url, init, headers: init.headers };
  return new Response("ok");
};
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const req = (path, init = {}) => worker.fetch(new Request("https://gw.example" + path, init), env, ctx);
const adminAuth = { authorization: "Basic " + btoa("admin:pw") };
const create = (body) => req("/admin/keys", { method: "POST", headers: { ...adminAuth, "content-type": "application/json" }, body: JSON.stringify(body) });
const inAnHour = new Date(Date.now() + 3600e3).toISOString();
const keyInfo = async (id) => (await req("/admin/keys/" + id, { headers: adminAuth })).json();
async function listAll() {
  const all = [];
  let cursor = "";
  do {
    const page = await (await req("/admin/keys" + (cursor ? "?cursor=" + cursor : ""), { headers: adminAuth })).json();
    assert.ok(page.keys.length <= 20, "pages stay within the subrequest budget");
    all.push(...page.keys);
    cursor = page.cursor;
  } while (cursor);
  return all;
}

test("admin requires the password", async () => {
  assert.equal((await req("/admin")).status, 401);
  assert.equal((await req("/admin", { headers: { authorization: "Basic " + btoa("admin:wrong") } })).status, 401);
  assert.equal((await req("/admin", { headers: adminAuth })).status, 200);
});

test("create validates input and needs a JSON content type", async () => {
  assert.equal((await create({ base: "http://x.example", key: "k", expires: inAnHour })).status, 400);
  assert.equal((await create({ base: "https://x.example", key: "", expires: inAnHour })).status, 400);
  assert.equal((await create({ base: "https://x.example", key: "k", expires: "2020-01-01" })).status, 400);
  const form = await req("/admin/keys", { method: "POST", headers: { ...adminAuth, "content-type": "text/plain" }, body: "{}" });
  assert.equal(form.status, 404);
});

test("created key proxies to the provider base with the real key", async () => {
  const { id } = await (await create({ base: "https://open.bigmodel.cn/api/paas/v4/", key: "real", expires: inAnHour })).json();
  for (const h of [{ authorization: `Bearer ${id}` }, { "x-api-key": id }]) {
    assert.equal((await req("/v1/chat/completions?x=1", { method: "POST", headers: { ...h, "x-forwarded-for": "1.2.3.4" }, body: "{}" })).status, 200);
    assert.equal(sent.url, "https://open.bigmodel.cn/api/paas/v4/chat/completions?x=1");
    assert.equal(sent.headers.get("authorization"), "Bearer real");
    assert.equal(sent.headers.get("x-api-key"), null);
    assert.equal(sent.headers.get("x-forwarded-for"), null);
  }
  const listed = await listAll();
  assert.ok(listed.some((k) => k.id === id && !("key" in k)), "list must not expose real keys");
  assert.ok(!("key" in (await keyInfo(id))), "key details must not expose real keys");

  assert.equal((await req("/admin/keys/" + id, { method: "DELETE", headers: adminAuth })).status, 200);
  assert.equal((await req("/v1/models", { headers: { authorization: `Bearer ${id}` } })).status, 401);
});

test("rejects unknown, oversized and expired keys", async () => {
  const old = "sk-gw-" + "0".repeat(32);
  store.set(old, { value: JSON.stringify({ base: "https://x.example", key: "k", expires: "2020-01-01T00:00:00Z" }) });
  for (const k of ["nope", "x".repeat(600), old]) {
    assert.equal((await req("/v1/models", { headers: { authorization: `Bearer ${k}` } })).status, 401);
  }
});

test("upstream failure becomes 502", async () => {
  const { id } = await (await create({ base: "https://x.example", key: "k", expires: inAnHour })).json();
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("boom"); };
  assert.equal((await req("/v1/models", { headers: { authorization: `Bearer ${id}` } })).status, 502);
  globalThis.fetch = real;
});

test("cost follows Anthropic list prices", () => {
  const M = 1e6;
  assert.equal(cost("claude-opus-5-5", { input_tokens: M, output_tokens: M }), 24);
  assert.equal(cost("claude-sonnet-5-5", { input_tokens: M, output_tokens: M }), 12);
  assert.equal(cost("anthropic/claude-haiku-5.5", { input_tokens: M, output_tokens: M }), 3);
  assert.equal(cost("claude-opus-5-5", { cache_read_input_tokens: M, cache_creation_input_tokens: M }), 5.2);
  assert.equal(cost("claude-opus-5-5", { cache_creation_input_tokens: M, cache_creation: { ephemeral_1h_input_tokens: M } }), 8);
  assert.equal(cost("gpt-x", { input_tokens: 5 }), null);
  assert.equal(cost("claude-sonnet-5-5", { cache_read_input_tokens: M }), 0.1, "Sonnet 5.5 cache reads are 0.05x");
  assert.equal(cost("claude-sonnet-5", { cache_read_input_tokens: M }), 0.2, "the longest matching name wins");
  assert.equal(cost("claude-opus-5-5", { input_tokens: M, speed: "fast" }), 8);
  assert.ok(Math.abs(cost("claude-opus-5-5", { input_tokens: M, inference_geo: "us" }) - 4.4) < 1e-9);
  assert.equal(cost("claude-haiku-5-5", { input_tokens: 50e3, cache_read_input_tokens: 60e3 }), (50e3 * 0.5 + 60e3 * 0.05) / M, "cache tokens count toward the 100K threshold");
});

test("messages calls are metered, streaming and not", async () => {
  const { id } = await (await create({ base: "https://x.example", key: "k", expires: inAnHour })).json();
  const real = globalThis.fetch;
  const call = async (body, type) => {
    globalThis.fetch = async () => new Response(body, { headers: { "content-type": type } });
    const res = await req("/v1/messages", { method: "POST", headers: { "x-api-key": id }, body: "{}" });
    assert.equal(await res.text(), body, "client gets the untouched body");
    await Promise.all(pending.splice(0));
  };
  await call(JSON.stringify({ model: "claude-opus-5-5", usage: { input_tokens: 1000, output_tokens: 500 } }), "application/json");
  await call([
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":2000,"output_tokens":1}}}',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":300}}',
  ].join("\n\n"), "text/event-stream");
  globalThis.fetch = real;
  const u = (await keyInfo(id)).usage.total;
  assert.ok(Math.abs(u["claude-opus-5-5"].cost - 0.014) < 1e-9);
  assert.ok(Math.abs(u["claude-sonnet-5-5"].cost - 0.007) < 1e-9);
  assert.equal(u["claude-sonnet-5-5"].output, 300);
});

const bearer = (id) => ({ authorization: `Bearer ${id}` });

test("auth style picks the header the real key travels in, and strips client identity", async () => {
  const { id } = await (await create({ base: "https://api.anthropic.com", key: "real", expires: inAnHour, auth: "x-api-key" })).json();
  const headers = { ...bearer(id), "cf-ipcountry": "IN", cookie: "a=b", origin: "https://site.example", "anthropic-version": "2023-06-01" };
  await req("/v1/messages", { method: "POST", headers, body: "{}" });
  assert.equal(sent.headers.get("x-api-key"), "real");
  assert.equal(sent.headers.get("authorization"), null, "the gateway key must not leak upstream");
  for (const h of ["cf-ipcountry", "cookie", "origin"]) assert.equal(sent.headers.get(h), null);
  assert.equal(sent.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(sent.init.redirect, "manual");
  assert.equal((await create({ base: "https://x.example", key: "k", expires: inAnHour, auth: "cookie" })).status, 400);
});

test("proxy answers CORS preflight and tags responses", async () => {
  const pre = await req("/v1/chat/completions", { method: "OPTIONS", headers: { "access-control-request-headers": "authorization,content-type" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.equal(pre.headers.get("access-control-allow-headers"), "authorization,content-type");
  assert.equal((await req("/v1/models")).headers.get("access-control-allow-origin"), "*");
  assert.equal((await req("/admin/keys", { headers: adminAuth })).headers.get("access-control-allow-origin"), null);
});

test("admin page refuses framing and create accepts a charset", async () => {
  const page = await req("/admin", { headers: adminAuth });
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  const res = await req("/admin/keys", {
    method: "POST",
    headers: { ...adminAuth, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ base: "https://x.example", key: "k", expires: inAnHour }),
  });
  assert.equal(res.status, 200);
});

test("model allowlist blocks other models", async () => {
  const { id } = await (await create({ base: "https://x.example", key: "k", expires: inAnHour, models: ["claude-haiku-*", "gpt-x"] })).json();
  const post = (model) => req("/v1/messages", { method: "POST", headers: bearer(id), body: JSON.stringify({ model }) });
  assert.equal((await post("claude-haiku-5-5")).status, 200);
  assert.equal((await post("gpt-x")).status, 200);
  assert.equal((await post("claude-opus-5-5")).status, 403);
  assert.equal((await req("/v1/messages", { method: "POST", headers: bearer(id), body: "not json" })).status, 403);
  assert.equal((await req("/v1/models", { headers: bearer(id) })).status, 200);
});

test("rate limit and spend cap return 429", async () => {
  const limited = (await (await create({ base: "https://x.example", key: "k", expires: inAnHour, rpm: 1 })).json()).id;
  assert.equal((await req("/v1/models", { headers: bearer(limited) })).status, 200);
  assert.equal((await req("/v1/models", { headers: bearer(limited) })).status, 429);

  const capped = (await (await create({ base: "https://x.example", key: "k", expires: inAnHour, capUsd: 0.01 })).json()).id;
  const real = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ model: "claude-opus-5-5", usage: { input_tokens: 1000, output_tokens: 500 } });
  assert.equal((await req("/v1/messages", { method: "POST", headers: bearer(capped), body: "{}" })).status, 200);
  await Promise.all(pending.splice(0));
  globalThis.fetch = real;
  assert.equal((await req("/v1/messages", { method: "POST", headers: bearer(capped), body: "{}" })).status, 429);
  assert.equal((await create({ base: "https://x.example", key: "k", expires: inAnHour, rpm: 1.5 })).status, 400);
});

test("expiry can be extended while active", async () => {
  const { id } = await (await create({ base: "https://x.example", key: "k", expires: inAnHour, label: "ci" })).json();
  const later = new Date(Date.now() + 7200e3).toISOString();
  const patch = (body) => req("/admin/keys/" + id, { method: "PATCH", headers: { ...adminAuth, "content-type": "application/json" }, body: JSON.stringify(body) });
  const res = await (await patch({ expires: later, key: "" })).json();
  assert.equal(res.expires, later);
  assert.equal(res.label, "ci");
  assert.equal(env.METER.get(id).storage.alarmAt, Date.parse(later));
  const realKey = async () => {
    await withUpstream(replying({}), () => req("/v1/models", { headers: bearer(id) }));
    return sent.headers.get("authorization");
  };
  assert.equal(await realKey(), "Bearer k", "a blank key keeps the current one");
  await patch({ key: "rotated", base: "https://y.example/", capUsd: 5 });
  const route = JSON.parse(store.get(id).value);
  assert.deepEqual([await realKey(), route.base, route.capUsd, route.expires], ["Bearer rotated", "https://y.example", 5, later]);
  assert.equal((await patch({ capUsd: null })).status, 200);
  assert.equal(JSON.parse(store.get(id).value).capUsd, undefined, "null clears a limit");
  assert.equal((await patch({ base: "http://insecure.example" })).status, 400);
  assert.equal((await patch({ expires: "2020-01-01" })).status, 400);
});

test("at expiry the real key is wiped but spend stays listed, then everything is purged", async () => {
  const { id } = await (await create({ base: "https://x.example", key: "secret", expires: inAnHour })).json();
  const { meter, storage } = env.METER.get(id);
  assert.equal(storage.alarmAt, Date.parse(inAnHour));
  const now = Date.now;
  try {
    Date.now = () => now() + 2 * 3600e3;
    await meter.alarm();
    assert.equal(JSON.parse(store.get(id).value).key, null);
    assert.equal((await req("/v1/models", { headers: bearer(id) })).status, 401);
    const listed = (await listAll()).find((k) => k.id === id);
    assert.equal(listed.active, false, "an expired key is listed as inactive");
    Date.now = () => now() + 31 * 864e5;
    await meter.alarm();
    assert.equal(storage.alarmAt, null);
    assert.equal(await storage.get("key"), undefined);
  } finally {
    Date.now = now;
  }
});

test("OpenAI chat and responses calls are metered", async () => {
  const { id } = await (await create({ base: "https://x.example", key: "k", expires: inAnHour })).json();
  const real = globalThis.fetch;
  const call = async (path, body, type) => {
    globalThis.fetch = async () => new Response(body, { headers: { "content-type": type } });
    await req(path, { method: "POST", headers: bearer(id), body: "{}" });
    await Promise.all(pending.splice(0));
  };
  await call("/v1/chat/completions", [
    'data: {"model":"anthropic/claude-sonnet-5.5","choices":[{"delta":{"content":"hi"}}],"usage":null}',
    'data: {"model":"anthropic/claude-sonnet-5.5","choices":[],"usage":{"prompt_tokens":3000,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":1000}}}',
    "data: [DONE]",
  ].join("\n\n"), "text/event-stream");
  await call("/v1/responses", JSON.stringify({ object: "response", model: "gpt-x", usage: { input_tokens: 50, output_tokens: 7, input_tokens_details: { cached_tokens: 0 } } }), "application/json");
  globalThis.fetch = real;
  const u = (await keyInfo(id)).usage;
  const sonnet = u.total["anthropic/claude-sonnet-5.5"];
  assert.deepEqual([sonnet.input, sonnet.output], [3000, 100]);
  assert.ok(Math.abs(sonnet.cost - (2000 * 2 + 1000 * 0.1 + 100 * 10) / 1e6) < 1e-12);
  assert.deepEqual([u.total["gpt-x"].input, u.total["gpt-x"].output, u.total["gpt-x"].priced], [50, 7, false]);
  assert.deepEqual(u.months[new Date().toISOString().slice(0, 7)]["gpt-x"].requests, 1);
});

const replying = (body, type = "application/json") => async (url, init) => {
  sent = { url, init, headers: init.headers };
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { headers: { "content-type": type } });
};
async function withUpstream(fn, run) {
  const real = globalThis.fetch;
  globalThis.fetch = fn;
  try { return await run(); } finally { globalThis.fetch = real; }
}
const opusCall = { model: "claude-opus-5-5", usage: { input_tokens: 1000, output_tokens: 500 } };

test("token cap and monthly period", async () => {
  const { id } = await (await create({ base: "https://x.example", key: "k", expires: inAnHour, capTokens: 1500, period: "month" })).json();
  const call = () => req("/v1/messages", { method: "POST", headers: bearer(id), body: "{}" });
  await withUpstream(replying(opusCall), async () => {
    assert.equal((await call()).status, 200);
    await Promise.all(pending.splice(0));
    const blocked = await call();
    assert.equal(blocked.status, 429);
    assert.match((await blocked.json()).error.message, /token cap of 1500 for this month/);
  });
  const { meter } = env.METER.get(id);
  const months = await meter.storage.get("months");
  months["2000-01"] = months[Object.keys(months)[0]];
  delete months[Object.keys(months)[0]];
  assert.equal((await withUpstream(replying(opusCall), call)).status, 200, "last month's usage does not count");
  assert.equal((await create({ base: "https://x.example", key: "k", expires: inAnHour, period: "week" })).status, 400);
  assert.equal((await create({ base: "https://x.example", key: "k", expires: inAnHour, capTokens: 0.5 })).status, 400);
});

test("max output tokens are clamped or filled in", async () => {
  const { id } = await (await create({ base: "https://x.example", key: "k", expires: inAnHour, maxOutput: 100 })).json();
  const bodyFor = async (path, payload) => {
    await withUpstream(replying({}), () => req(path, { method: "POST", headers: bearer(id), body: JSON.stringify(payload) }));
    return JSON.parse(sent.init.body);
  };
  assert.equal((await bodyFor("/v1/messages", { model: "m", max_tokens: 32000 })).max_tokens, 100);
  assert.equal((await bodyFor("/v1/messages", { model: "m", max_tokens: 50 })).max_tokens, 50);
  assert.equal((await bodyFor("/v1/chat/completions", { model: "m", max_completion_tokens: 900 })).max_completion_tokens, 100);
  assert.equal((await bodyFor("/v1/chat/completions", { model: "m" })).max_tokens, 100);
  assert.equal((await bodyFor("/v1/responses", { model: "m" })).max_output_tokens, 100);
  assert.equal((await bodyFor("/v1/messages/count_tokens", { model: "m" })).max_tokens, undefined, "non-generation calls get no new field");
});

test("IP allowlist", async () => {
  assert.ok(inRange("203.0.113.9", "203.0.113.0/24"));
  assert.ok(!inRange("203.0.114.9", "203.0.113.0/24"));
  assert.ok(inRange("2001:db8::1", "2001:db8::/32"));
  assert.ok(inRange("::ffff:10.0.0.1", "::ffff:10.0.0.0/120"));
  assert.ok(!inRange("2001:db9::1", "2001:db8::/32"));
  assert.ok(!inRange("10.0.0.1", "2001:db8::/32"));
  assert.ok(inRange("10.1.2.3", "10.1.2.3"));
  for (const bad of ["1.2.3.256", "1::2::3", "zz::1", "1.2.3"]) assert.equal(parseIp(bad), null, bad);
  assert.equal(parseIp("1:2:3:4:5:6:7:8").bits, 128);

  const { id } = await (await create({ base: "https://x.example", key: "k", expires: inAnHour, ips: ["203.0.113.0/24", "2001:db8::/32"] })).json();
  const from = (ip) => req("/v1/models", { headers: { ...bearer(id), "cf-connecting-ip": ip } });
  assert.equal((await from("203.0.113.7")).status, 200);
  assert.equal((await from("2001:db8:0:1::5")).status, 200);
  assert.equal((await from("198.51.100.1")).status, 403);
  assert.equal((await req("/v1/models", { headers: bearer(id) })).status, 403);
  assert.equal((await create({ base: "https://x.example", key: "k", expires: inAnHour, ips: ["10.0.0.0/33"] })).status, 400);
});

test("model list endpoint uses the right auth and the stored key", async () => {
  const listModels = (body) => req("/admin/models", { method: "POST", headers: { ...adminAuth, "content-type": "application/json" }, body: JSON.stringify(body) });
  const res = await withUpstream(replying({ data: [{ id: "claude-b" }, { id: "claude-a" }, { id: "claude-a" }] }), () =>
    listModels({ base: "https://api.anthropic.com/v1/", key: "real", auth: "x-api-key" }));
  assert.deepEqual((await res.json()).models, ["claude-a", "claude-b"]);
  assert.equal(sent.url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(sent.headers.get("x-api-key"), "real");
  assert.equal(sent.headers.get("anthropic-version"), "2023-06-01");

  const { id } = await (await create({ base: "https://y.example/v1", key: "stored", expires: inAnHour })).json();
  const byId = await withUpstream(replying({ models: [{ name: "gemma" }], object: "list" }), () => listModels({ id }));
  assert.deepEqual((await byId.json()).models, ["gemma"]);
  assert.equal(sent.url, "https://y.example/v1/models");
  assert.equal(sent.headers.get("authorization"), "Bearer stored");

  const failed = await withUpstream(async () => Response.json({ error: { message: "bad key" } }, { status: 401 }), () => listModels({ id }));
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error.message, /401: bad key/);
  assert.equal((await listModels({ base: "https://y.example" })).status, 400);
});

test("allowed models also filter the client's model list", async () => {
  const { id } = await (await create({ base: "https://x.example", key: "k", expires: inAnHour, models: ["claude-haiku-*"] })).json();
  const res = await withUpstream(replying({ data: [{ id: "claude-haiku-5-5" }, { id: "claude-opus-5-5" }] }), () =>
    req("/v1/models", { headers: bearer(id) }));
  assert.deepEqual((await res.json()).data.map((m) => m.id), ["claude-haiku-5-5"]);
});

test("prices are editable and used for metering", async () => {
  const put = (prices) => req("/admin/prices", { method: "PUT", headers: { ...adminAuth, "content-type": "application/json" }, body: JSON.stringify({ prices }) });
  const got = await (await req("/admin/prices", { headers: adminAuth })).json();
  assert.deepEqual(got.defaults, DEFAULT_PRICES);
  assert.equal((await put([{ match: "", in: 1, out: 1, read: 1, write5m: 1, write1h: 1 }])).status, 400);
  assert.equal((await put([{ match: "x", in: -1, out: 1, read: 1, write5m: 1, write1h: 1 }])).status, 400);
  assert.equal((await put([{ match: "x", in: 1, out: 1, read: 1, write5m: 1, write1h: 1, fast: 0 }])).status, 400);
  assert.equal((await put([...DEFAULT_PRICES, { match: "deepseek-chat", in: "1", out: 2, read: 0.1, write5m: 1, write1h: 1, fast: "" }])).status, 200);
  assert.deepEqual(JSON.parse(store.get("config:prices").value).at(-1), { match: "deepseek-chat", in: 1, out: 2, read: 0.1, write5m: 1, write1h: 1 });

  const { id } = await (await create({ base: "https://x.example", key: "k", expires: inAnHour })).json();
  await withUpstream(replying({ model: "deepseek-chat", usage: { prompt_tokens: 1e6, completion_tokens: 1e6 } }), () =>
    req("/v1/chat/completions", { method: "POST", headers: bearer(id), body: "{}" }));
  await Promise.all(pending.splice(0));
  const u = (await keyInfo(id)).usage.total;
  assert.equal(u["deepseek-chat"].cost, 3);
  assert.ok(!(await listAll()).some((k) => k.id === "config:prices"));
  await put(DEFAULT_PRICES);
});

test("Gemini-style query key, path model and binary bodies", async () => {
  const { id } = await (await create({ base: "https://g.example/v1beta", key: "real", expires: inAnHour, auth: "x-goog-api-key", models: ["gemini-pro"] })).json();
  await withUpstream(replying({}), () => req(`/v1/models/gemini-pro:generateContent?alt=sse&key=${id}`, { method: "POST", body: "{}" }));
  assert.equal(sent.url, "https://g.example/v1beta/models/gemini-pro:generateContent?alt=sse", "the gateway key stays out of the upstream URL");
  assert.equal(sent.headers.get("x-goog-api-key"), "real");
  assert.equal((await req(`/v1/models/gemini-ultra:generateContent?key=${id}`, { method: "POST", body: "{}" })).status, 403);

  const capped = (await (await create({ base: "https://x.example", key: "k", expires: inAnHour, maxOutput: 10 })).json()).id;
  const bytes = new Uint8Array([0xff, 0x00, 0xc3, 0x28, 0x80]);
  await withUpstream(replying({}), () => req("/v1/audio/transcriptions", { method: "POST", headers: bearer(capped), body: bytes }));
  assert.deepEqual(new Uint8Array(sent.init.body), bytes);
});

test("usage can be reset and keys duplicated without resending the real key", async () => {
  const { id } = await (await create({ base: "https://x.example", key: "secret", expires: inAnHour, capUsd: 0.01, label: "orig" })).json();
  await withUpstream(replying(opusCall), () => req("/v1/messages", { method: "POST", headers: bearer(id), body: "{}" }));
  await Promise.all(pending.splice(0));
  assert.equal((await req("/v1/messages", { method: "POST", headers: bearer(id), body: "{}" })).status, 429);
  assert.equal((await req(`/admin/keys/${id}/usage`, { method: "DELETE", headers: adminAuth })).status, 200);
  assert.equal((await withUpstream(replying(opusCall), () => req("/v1/messages", { method: "POST", headers: bearer(id), body: "{}" }))).status, 200);
  assert.equal(env.METER.get(id).storage.alarmAt, Date.parse(inAnHour), "reset keeps the expiry alarm");

  const copy = await (await create({ base: "https://x.example", from: id, expires: inAnHour, label: "copy" })).json();
  await withUpstream(replying({}), () => req("/v1/models", { headers: bearer(copy.id) }));
  assert.equal(sent.headers.get("authorization"), "Bearer secret");
  assert.equal((await create({ base: "https://x.example", from: "sk-gw-" + "f".repeat(32), expires: inAnHour })).status, 400);
});

test("real keys are encrypted at rest and bound to their id", async () => {
  const { id } = await (await create({ base: "https://x.example", key: "plain-secret", expires: inAnHour })).json();
  const stored = JSON.parse(store.get(id).value).key;
  assert.match(stored, /^enc:v1:/);
  assert.ok(!store.get(id).value.includes("plain-secret"));
  await withUpstream(replying({}), () => req("/v1/models", { headers: bearer(id) }));
  assert.equal(sent.headers.get("authorization"), "Bearer plain-secret");

  const other = "sk-gw-" + "a".repeat(32);
  store.set(other, { value: store.get(id).value });
  assert.equal((await req("/v1/models", { headers: bearer(other) })).status, 500, "a copied ciphertext does not decrypt under another id");
  store.delete(other);
  const secret = env.ENCRYPTION_KEY;
  env.ENCRYPTION_KEY = "a different secret";
  assert.equal((await req("/v1/models", { headers: bearer(id) })).status, 500);
  env.ENCRYPTION_KEY = secret;

  const legacy = "sk-gw-" + "b".repeat(32);
  store.set(legacy, { value: JSON.stringify({ base: "https://x.example", key: "legacy", expires: inAnHour }) });
  await withUpstream(replying({}), () => req("/v1/models", { headers: bearer(legacy) }));
  assert.equal(sent.headers.get("authorization"), "Bearer legacy", "keys stored before encryption still work");
  store.delete(legacy);
  assert.equal((await (await req("/admin/status", { headers: adminAuth })).json()).encrypted, true);
});

test("batch create and paged listing", async () => {
  const res = await create({ base: "https://x.example", key: "k", expires: inAnHour, label: "team", count: 20 });
  const { keys } = await res.json();
  assert.deepEqual(keys.slice(0, 3).map((k) => k.label), ["team 1", "team 2", "team 3"]);
  assert.equal(new Set(keys.map((k) => k.id)).size, 20);
  assert.equal((await create({ base: "https://x.example", key: "k", expires: inAnHour, count: 21 })).status, 400);
  assert.equal((await create({ base: "https://x.example", key: "k", expires: inAnHour, count: 0 })).status, 400);

  const first = await (await req("/admin/keys", { headers: adminAuth })).json();
  assert.equal(first.keys.length, 20);
  assert.ok(first.cursor);
  const all = await listAll();
  assert.ok(keys.every((k) => all.some((l) => l.id === k.id)));
  assert.equal(all.find((l) => l.id === keys[0].id).limits, "none");
});

test("downgrade reroutes only new requests once a cap passes the threshold", async () => {
  const downgrade = { at: 50, map: [["claude-opus-*", "claude-sonnet-5-5"]] };
  const { id } = await (await create({ base: "https://x.example", key: "k", expires: inAnHour, capUsd: 0.02, downgrade })).json();
  const call = (model) => req("/v1/messages", { method: "POST", headers: bearer(id), body: JSON.stringify({ model, max_tokens: 10 }) });
  const sentModel = () => JSON.parse(typeof sent.init.body === "string" ? sent.init.body : new TextDecoder().decode(sent.init.body)).model;
  let res = await withUpstream(replying(opusCall), () => call("claude-opus-5-5"));
  assert.equal(sentModel(), "claude-opus-5-5");
  assert.equal(res.headers.get("x-gateway-downgrade"), null);
  await Promise.all(pending.splice(0));

  res = await withUpstream(replying({}), () => call("claude-opus-5-5"));
  assert.equal(sentModel(), "claude-sonnet-5-5");
  assert.equal(res.headers.get("x-gateway-downgrade"), "claude-opus-5-5 -> claude-sonnet-5-5");
  await withUpstream(replying({}), () => call("claude-haiku-5-5"));
  assert.equal(sentModel(), "claude-haiku-5-5", "models without a rule are untouched");

  assert.equal((await create({ base: "https://x.example", key: "k", expires: inAnHour, downgrade })).status, 400, "needs a cap");
  assert.equal((await create({ base: "https://x.example", key: "k", expires: inAnHour, capUsd: 1, downgrade: { at: 0, map: downgrade.map } })).status, 400);
  assert.equal((await create({ base: "https://x.example", key: "k", expires: inAnHour, capUsd: 1, downgrade: { at: 80, map: [["only-one"]] } })).status, 400);
});

test("time windows", async () => {
  const office = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", tz: "Asia/Kolkata" };
  assert.ok(withinHours(office, new Date("2026-10-12T04:00:00Z")), "Monday 09:30 in Kolkata");
  assert.ok(!withinHours(office, new Date("2026-10-12T03:00:00Z")), "Monday 08:30 in Kolkata");
  assert.ok(!withinHours(office, new Date("2026-10-11T04:00:00Z")), "Sunday");
  const night = { days: [5], start: "22:00", end: "02:00", tz: "UTC" };
  assert.ok(withinHours(night, new Date("2026-10-16T23:00:00Z")), "Friday night");
  assert.ok(withinHours(night, new Date("2026-10-17T01:00:00Z")), "early Saturday belongs to Friday's window");
  assert.ok(!withinHours(night, new Date("2026-10-17T03:00:00Z")));
  assert.ok(!withinHours(night, new Date("2026-10-15T23:00:00Z")), "Thursday night");
  assert.ok(withinHours({ days: [1], start: "00:00", end: "00:00", tz: "UTC" }, new Date("2026-10-12T23:59:00Z")), "same start and end is the whole day");

  const { id } = await (await create({ base: "https://x.example", key: "k", expires: inAnHour, hours: { days: [1], start: "09:00", end: "10:00", tz: "UTC" } })).json();
  const now = Date.now;
  try {
    Date.now = () => Date.parse("2026-10-12T09:30:00Z");
    assert.equal((await withUpstream(replying({}), () => req("/v1/models", { headers: bearer(id) }))).status, 200);
    Date.now = () => Date.parse("2026-10-12T10:30:00Z");
    const shut = await req("/v1/models", { headers: bearer(id) });
    assert.equal(shut.status, 403);
    assert.match((await shut.json()).error.message, /only works Mon 09:00-10:00 \(UTC\)/);
  } finally {
    Date.now = now;
  }
  for (const hours of [{ days: [], start: "09:00", end: "10:00", tz: "UTC" }, { days: [1], start: "9:00", end: "10:00", tz: "UTC" }, { days: [1], start: "09:00", end: "10:00", tz: "Mars/Base" }]) {
    assert.equal((await create({ base: "https://x.example", key: "k", expires: inAnHour, hours })).status, 400, JSON.stringify(hours));
  }
});

test("key holders can check their own usage", async () => {
  const { id } = await (await create({ base: "https://x.example", key: "k", expires: inAnHour, capUsd: 1, capTokens: 10000, period: "month", label: "mine" })).json();
  await withUpstream(replying(opusCall), () => req("/v1/messages", { method: "POST", headers: bearer(id), body: "{}" }));
  await Promise.all(pending.splice(0));
  const u = await (await req("/usage", { headers: bearer(id) })).json();
  assert.deepEqual([u.label, u.active, u.period, u.used.tokens, u.remaining.tokens], ["mine", true, "month", 1500, 8500]);
  assert.ok(Math.abs(u.remaining.usd - 0.986) < 1e-9);
  assert.equal((await (await req(`/usage?key=${id}`)).json()).label, "mine");
  const html = await req("/usage");
  assert.match(html.headers.get("content-type"), /text\/html/);
  assert.equal((await req("/usage", { headers: bearer("sk-gw-" + "c".repeat(32)) })).status, 401);
});

test("one-time share links", async () => {
  const { id } = await (await create({ base: "https://x.example", key: "k", expires: inAnHour, label: "shared", models: ["m"] })).json();
  const makeLink = async (key) => (await req(`/admin/keys/${key}/share`, { method: "POST", headers: { ...adminAuth, "content-type": "application/json" }, body: "{}" })).json();
  const { url, expires } = await makeLink(id);
  assert.equal(expires, inAnHour, "a link never outlives its key");
  const path = new URL(url).pathname;
  const pageRes = await req(path);
  assert.match(await pageRes.text(), /Reveal key/);
  assert.equal(pageRes.headers.get("referrer-policy"), "no-referrer");
  const revealed = await req(path, { method: "POST" });
  assert.deepEqual(await revealed.json(), { key: id, endpoint: "https://gw.example/v1", origin: "https://gw.example", label: "shared", expires: inAnHour, models: ["m"] });
  assert.equal((await req(path, { method: "POST" })).status, 410, "a link works once");

  const second = new URL((await makeLink(id)).url).pathname;
  await req("/admin/keys/" + id, { method: "DELETE", headers: adminAuth });
  assert.equal((await req(second, { method: "POST" })).status, 410, "revoking the key kills its links");
});

test("OpenRouter's reported cost wins and its prices can be imported", async () => {
  const body = JSON.stringify({ model: "anthropic/claude-opus-5.5", usage: { prompt_tokens: 1e6, completion_tokens: 0, cost: 0.5 } });
  const run = async (base) => {
    const { id } = await (await create({ base, key: "k", expires: inAnHour })).json();
    await withUpstream(replying(body), () => req("/v1/chat/completions", { method: "POST", headers: bearer(id), body: "{}" }));
    await Promise.all(pending.splice(0));
    return (await keyInfo(id)).usage.total["anthropic/claude-opus-5.5"].cost;
  };
  assert.equal(await run("https://openrouter.ai/api/v1"), 0.5);
  assert.equal(await run("https://x.example"), 4, "other providers' cost fields are ignored");

  const list = { data: [
    { id: "a/b", pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" } },
    { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
    { id: "c/free", pricing: { prompt: "0", completion: "0" } },
  ] };
  const res = await withUpstream(replying(list), () => req("/admin/prices/openrouter", { headers: adminAuth }));
  assert.equal(sent.url, "https://openrouter.ai/api/v1/models");
  assert.deepEqual((await res.json()).prices, [
    { match: "a/b", in: 3, out: 15, read: 0.3, write5m: 3, write1h: 3 },
    { match: "c/free", in: 0, out: 0, read: 0, write5m: 0, write1h: 0 },
  ]);
});

const enc = (s) => new TextEncoder().encode(s);
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sha = async (data) => new Uint8Array(await crypto.subtle.digest("SHA-256", data));
// WebAuthn sends ECDSA signatures DER-encoded; WebCrypto produces raw r||s.
function rawToDer(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.slice(i);
    return [2, ...(b[0] & 0x80 ? [b.length + 1, 0] : [b.length]), ...b];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}
async function authenticator() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { id: b64u(crypto.getRandomValues(new Uint8Array(20))), pair, spki: b64u(await crypto.subtle.exportKey("spki", pair.publicKey)) };
}
async function assertion(auth, challenge, { origin = "https://gw.example", flags = 5, rpId = "gw.example" } = {}) {
  const clientData = enc(JSON.stringify({ type: "webauthn.get", challenge, origin }));
  const authData = new Uint8Array([...(await sha(enc(rpId))), flags, 0, 0, 0, 1]);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, auth.pair.privateKey, new Uint8Array([...authData, ...(await sha(clientData))])));
  return { id: auth.id, clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(rawToDer(raw)) };
}

test("passkeys replace the password", async () => {
  const post = (path, body, headers = adminAuth) => req(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  const auth = await authenticator();
  const { challenge, rp } = await (await post("/admin/passkeys/options", {})).json();
  assert.equal(rp.id, "gw.example");
  const registration = { id: auth.id, clientDataJSON: b64u(enc(JSON.stringify({ type: "webauthn.create", challenge, origin: "https://gw.example" }))), publicKey: auth.spki, alg: -7, name: "laptop" };
  const reg = await post("/admin/passkeys", registration);
  assert.equal(reg.status, 200);
  const cookie = reg.headers.get("set-cookie").split(";")[0];
  assert.equal((await post("/admin/passkeys", registration, { cookie })).status, 400, "a registration challenge works once");

  const loginPage = await req("/admin", { headers: adminAuth });
  assert.match(await loginPage.text(), /Sign in with a passkey/, "the password stops working once a passkey exists");
  assert.equal((await req("/admin/keys", { headers: adminAuth })).status, 401);
  assert.equal((await req("/admin/keys", { headers: { cookie } })).status, 200);

  const options = async () => (await (await req("/admin/login/options", { method: "POST" })).json()).challenge;
  const good = await assertion(auth, await options());
  const login = await post("/admin/login", good, {});
  assert.equal(login.status, 200);
  const session = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await req("/admin/keys", { headers: { cookie: session } })).status, 200);
  assert.equal((await post("/admin/login", good, {})).status, 401, "an assertion cannot be replayed");
  assert.equal((await post("/admin/login", await assertion(auth, await options(), { origin: "https://evil.example" }), {})).status, 401);
  assert.equal((await post("/admin/login", await assertion(auth, await options(), { rpId: "evil.example" }), {})).status, 401);
  assert.equal((await post("/admin/login", await assertion(auth, await options(), { flags: 1 }), {})).status, 401, "user verification is required");
  const stranger = await authenticator();
  assert.equal((await post("/admin/login", { ...(await assertion(stranger, await options())), id: auth.id }, {})).status, 401, "another key's signature fails");
  const [, exp, sig] = session.match(/=(\d+)\.(.+)$/);
  assert.equal((await req("/admin/keys", { headers: { cookie: `kr_session=${Number(exp) + 1}.${sig}` } })).status, 401, "a tampered session fails");

  env.ALLOW_PASSWORD = "true";
  assert.equal((await req("/admin/keys", { headers: adminAuth })).status, 200, "ALLOW_PASSWORD brings the password back");
  delete env.ALLOW_PASSWORD;
  assert.deepEqual((await (await req("/admin/passkeys", { headers: { cookie: session } })).json()).map((p) => p.name), ["laptop"]);
  await req("/admin/passkeys/" + auth.id, { method: "DELETE", headers: { cookie: session } });
  assert.equal((await req("/admin/keys", { headers: adminAuth })).status, 200, "removing the last passkey restores the password");
});
