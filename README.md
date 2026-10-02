# Key Router

A Cloudflare Worker that wraps any OpenAI-compatible provider key (OpenRouter, DeepSeek, Groq, Zhipu, and so on) in a disposable gateway key with an expiry. Clients only ever see the gateway key; the worker swaps in the real key and forwards the request, streaming included.

## Using it

Open `https://<worker>.workers.dev/admin` and sign in with the admin password (the username is ignored). Then enter:

- the provider's base URL exactly as its docs give it (for example `https://openrouter.ai/api/v1`)
- the real API key
- an expiry

The page returns the endpoint and gateway key to hand out. Keys expire on their own and can be revoked from the same page; revocation can take up to a minute to reach every edge location.

Clients set their base URL to `https://<worker>.workers.dev/v1` and send the gateway key as `Authorization: Bearer` or `x-api-key`.

## Deploying your own

```
npx wrangler login
npx wrangler kv namespace create KEYS      # put the printed id in wrangler.toml
npx wrangler secret put ADMIN_PASSWORD
npx wrangler deploy
```

The admin password can later be changed in the Cloudflare dashboard under the worker's Variables and Secrets.

## Notes

- The gateway does not cap spend. Set credit limits on the provider side.
- Real keys are stored in Workers KV and are never returned by the admin API.

## Tests

```
npm test
```

## Revoking

Use the Revoke button on the admin page, or delete the entry under Storage & Databases > KV > `KEYS` in the Cloudflare dashboard.
