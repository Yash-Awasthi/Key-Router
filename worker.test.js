import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";

const future = new Date(Date.now() + 3600e3).toISOString();
const env = {
  ROUTES: JSON.stringify({
    good: { base: "https://up.example/api/", key: "real-key", expires: future },
    old: { base: "https://up.example/api", key: "real-key", expires: "2020-01-01T00:00:00Z" },
    noexp: { base: "https://up.example/api", key: "real-key" },
    plain: { base: "http://up.example/api", key: "real-key", expires: future },
  }),
};

let sent;
globalThis.fetch = async (url, init) => {
  sent = { url, headers: init.headers };
  return new Response("ok");
};
const call = (headers, e = env) =>
  worker.fetch(new Request("https://gw.example/v1/chat/completions?x=1", { method: "POST", headers, body: "{}" }), e);

test("rejects missing, wrong, prototype, expired and undated keys", async () => {
  for (const h of [{}, { authorization: "Bearer nope" }, { authorization: "Bearer toString" },
                   { authorization: "Bearer old" }, { authorization: "Bearer noexp" }]) {
    assert.equal((await call(h)).status, 401, JSON.stringify(h));
  }
});

test("forwards with the real key as Bearer, path and query intact", async () => {
  for (const h of [{ authorization: "Bearer good" }, { "x-api-key": "good" }]) {
    sent = null;
    assert.equal((await call({ ...h, "x-forwarded-for": "1.2.3.4" })).status, 200);
    assert.equal(sent.url, "https://up.example/api/v1/chat/completions?x=1");
    assert.equal(sent.headers.get("authorization"), "Bearer real-key");
    assert.equal(sent.headers.get("x-api-key"), null);
    assert.equal(sent.headers.get("x-forwarded-for"), null);
  }
});

test("refuses non-https upstreams and bad config", async () => {
  assert.equal((await call({ authorization: "Bearer plain" })).status, 500);
  assert.equal((await call({ authorization: "Bearer good" }, { ROUTES: "{bad" })).status, 500);
});

test("upstream failure becomes 502", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("boom"); };
  assert.equal((await call({ authorization: "Bearer good" })).status, 502);
  globalThis.fetch = real;
});
