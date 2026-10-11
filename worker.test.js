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
        const storage = { get: async (k) => data.get(k), put: async (k, v) => void data.set(k, v), deleteAll: async () => data.clear() };
        const meter = new Meter({ storage });
        meters.set(name, { fetch: (url, init) => meter.fetch(new Request(url, init)) });
      }
      return meters.get(name);
    },
  },
  KEYS: {
    async get(k) { return store.has(k) ? JSON.parse(store.get(k).value) : null; },
    async put(k, value, opts) { store.set(k, { value, ...opts }); },
    async delete(k) { store.delete(k); },
    async list() { return { keys: [...store].map(([name, v]) => ({ name, metadata: v.metadata })) }; },
  },
};

let sent;
globalThis.fetch = async (url, init) => {
  sent = { url, headers: init.headers };
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
  store.set("old", { value: JSON.stringify({ base: "https://x.example", key: "k", expires: "2020-01-01T00:00:00Z" }) });
  for (const k of ["nope", "x".repeat(600), "old"]) {
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
