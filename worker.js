export default {
  async fetch(req, env) {
    let routes;
    try {
      routes = JSON.parse(env.ROUTES || "{}");
    } catch {
      return json(500, "ROUTES secret is not valid JSON");
    }

    const presented = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || req.headers.get("x-api-key") || "";
    const route = presented && Object.hasOwn(routes, presented) ? routes[presented] : null;
    if (!route || !(Date.now() < Date.parse(route.expires))) return json(401, "invalid or expired key");
    if (!/^https:\/\//.test(route.base) || !route.key) return json(500, "route needs an https base and a key");

    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${route.key}`);
    for (const h of ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"]) headers.delete(h);

    try {
      return await fetch(route.base.replace(/\/+$/, "") + url.pathname + url.search, {
        method: req.method,
        headers,
        body: req.body,
      });
    } catch (err) {
      return json(502, `upstream unreachable: ${err.message}`);
    }
  },
};

function json(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
