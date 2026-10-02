# Router

A Cloudflare Worker that hands out disposable API keys for any OpenAI-compatible provider (OpenRouter, DeepSeek, Groq, Together, and so on). Clients only ever see a gateway key; the worker swaps it for the real provider key and forwards the request, streaming included.

## Setup

```
npx wrangler login
npx wrangler deploy
```

Create the routes, one entry per gateway key. `base` is the provider URL without the trailing `/v1`, and `expires` is required.

```json
{
  "<random gateway key>": {
    "base": "https://openrouter.ai/api",
    "key": "sk-or-...",
    "expires": "2026-10-03T12:00:00Z"
  }
}
```

Generate gateway keys with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`, then upload the file:

```
npx wrangler secret put ROUTES < routes.json
```

Re-uploading replaces every route, which is also how a key is revoked.

## Client configuration

- Base URL: `https://<worker>.workers.dev/v1`
- API key: the gateway key

Keys are accepted as `Authorization: Bearer` or `x-api-key`. Upstream always receives `Authorization: Bearer <real key>`.

## Notes

- The gateway does not cap spend. Set credit limits on the provider side.
- `routes.json` and `.dev.vars` are git-ignored; never commit real keys.

## Tests

```
npm test
```
