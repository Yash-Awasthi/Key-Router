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
const { default: worker, Meter } = await import("./worker.js");

const store = new Map();
const meters = new Map();
const env = {
  ADMIN_PASSWORD: "pw",
  METER: {
    idFromName: (name) => name,
    get(name) {
      if (!meters.has(name)) {
        const data = new Map();
        const storage = {
          alarmAt: null,
          get: async (k) => data.get(k),
          put: async (k, v) => void data.set(k, v),
          deleteAll: async () => data.clear(),
          setAlarm: async (t) => void (storage.alarmAt = t),
          deleteAlarm: async () => void (storage.alarmAt = null),
        };
        const meter = new Meter({ storage }, env);
        meters.set(name, { meter, storage, fetch: (url, init) => meter.fetch(new Request(url, init)) });
      }
      return meters.get(name);
    },
  },
  KEYS: {
    async get(k) { return store.has(k) ? JSON.parse(store.get(k).value) : null; },
    async getWithMetadata(k) { return { value: await this.get(k), metadata: store.get(k)?.metadata ?? null }; },
    async put(k, value, opts) { store.set(k, { value, ...opts }); },
    async delete(k) { store.delete(k); },
    // Two per page, so every listing exercises the cursor loop.
    async list({ prefix = "", cursor = "0" } = {}) {
      const all = [...store].filter(([name]) => name.startsWith(prefix));
      const at = Number(cursor);
      const keys = all.slice(at, at + 2).map(([name, v]) => ({ name, metadata: v.metadata }));
      return at + 2 >= all.length ? { keys, list_complete: true } : { keys, list_complete: false, cursor: String(at + 2) };
    },
  },
};

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
  const listed = await (await req("/admin/keys", { headers: adminAuth })).json();
  assert.ok(listed.some((k) => k.id === id && !("key" in k)), "list must not expose real keys");

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

test("cost follows Anthropic list prices", async () => {
  const { cost } = await import("./worker.js");
  const M = 1e6;
  assert.equal(cost("claude-opus-5-5", { input_tokens: M, output_tokens: M }), 24);
  assert.equal(cost("claude-sonnet-5-5", { input_tokens: M, output_tokens: M }), 12);
  assert.equal(cost("anthropic/claude-haiku-5.5", { input_tokens: M, output_tokens: M }), 3);
  assert.equal(cost("claude-opus-5-5", { cache_read_input_tokens: M, cache_creation_input_tokens: M }), 5.2);
  assert.equal(cost("claude-opus-5-5", { cache_creation_input_tokens: M, cache_creation: { ephemeral_1h_input_tokens: M } }), 8);
  assert.equal(cost("claude-opus-4-8", { input_tokens: 5 }), null);
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
  const u = (await (await req("/admin/keys", { headers: adminAuth })).json()).find((k) => k.id === id).usage;
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

  const capped = (await (await create({ base: "https://x.example", key: "k", expires: inAnHour, cap: 0.01 })).json()).id;
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
  const res = await (await patch({ expires: later, key: "stolen", base: "https://evil.example" })).json();
  assert.equal(res.expires, later);
  assert.equal(res.label, "ci");
  assert.equal(env.METER.get(id).storage.alarmAt, Date.parse(later));
  const route = JSON.parse(store.get(id).value);
  assert.equal(route.key, "k", "PATCH must not change the real key");
  assert.equal(route.base, "https://x.example");
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
    assert.ok((await (await req("/admin/keys", { headers: adminAuth })).json()).some((k) => k.id === id));
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
  const u = (await (await req("/admin/keys", { headers: adminAuth })).json()).find((k) => k.id === id).usage;
  const sonnet = u["anthropic/claude-sonnet-5.5"];
  assert.deepEqual([sonnet.input, sonnet.output], [3000, 100]);
  assert.ok(Math.abs(sonnet.cost - (2000 * 2 + 1000 * 0.2 + 100 * 10) / 1e6) < 1e-12);
  assert.deepEqual([u["gpt-x"].input, u["gpt-x"].output, u["gpt-x"].priced], [50, 7, false]);
});
