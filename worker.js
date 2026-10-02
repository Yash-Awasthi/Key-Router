import PAGE from "./admin.html";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return admin(req, env, url);
    return proxy(req, env, url);
  },
};

async function proxy(req, env, url) {
  const presented = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || req.headers.get("x-api-key") || "";
  // KV rejects keys over 512 bytes, so oversized input must not reach it.
  const route = presented && presented.length <= 128 ? await env.KEYS.get(presented, "json") : null;
  if (!route || !(Date.now() < Date.parse(route.expires))) return json(401, "invalid or expired key");

  const headers = new Headers(req.headers);
  headers.delete("x-api-key");
  headers.set("authorization", `Bearer ${route.key}`);
  for (const h of ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"]) headers.delete(h);

  // Clients use <gateway>/v1; the stored base is the provider's own base URL, which may end in /v1, /v4 or nothing.
  const path = url.pathname.replace(/^\/v1(?=\/|$)/, "");
  try {
    return await fetch(route.base + path + url.search, { method: req.method, headers, body: req.body });
  } catch (err) {
    return json(502, `upstream unreachable: ${err.message}`);
  }
}

async function admin(req, env, url) {
  if (!(await authorized(req, env))) {
    return new Response("login required", { status: 401, headers: { "www-authenticate": 'Basic realm="Router admin"' } });
  }
  if (url.pathname === "/admin") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });

  if (url.pathname === "/admin/keys" && req.method === "GET") {
    const { keys } = await env.KEYS.list();
    return Response.json(keys.map((k) => ({ id: k.name, ...k.metadata })));
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
