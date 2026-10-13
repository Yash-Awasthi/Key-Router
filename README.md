# Key Router

A Cloudflare Worker that hands out disposable API keys. You store a real provider key once; the worker gives you gateway keys (`sk-gw-...`) that expire on their own and can be limited. Clients call the worker with a gateway key, and the worker forwards the request to the provider with the real key. Streaming works.

It works with Anthropic, OpenAI, Gemini, Azure OpenAI, OpenRouter, DeepSeek, Groq, Mistral, xAI and any other provider with an OpenAI- or Anthropic-style API. It runs on the Cloudflare free plan.

## What a gateway key can do

- Expire at a set time. The real key is erased from storage at expiry.
- Allow only chosen models. The admin page loads the provider's model list for you to tick.
- Cap spend in USD and tokens, over its lifetime or per calendar month.
- Switch new requests to a cheaper model once it has used a set share of its cap.
- Limit requests per minute and output tokens per request.
- Work only from given IP ranges, or only during given days and hours.

The admin page also tracks usage and cost per key, exports them as CSV, and hands keys out through one-time links. Key holders can check their own remaining budget at `/usage`.

## Deploy

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up), [Node.js](https://nodejs.org) 22+ and Git.

```
git clone https://github.com/Yash-Awasthi/Key-Router.git
cd Key-Router
npm run setup
```

`setup` logs you in to Cloudflare in the browser, deploys the worker, and asks for two secrets:

- `ADMIN_PASSWORD`: protects the admin page until you add a passkey.
- `ENCRYPTION_KEY`: encrypts real provider keys in storage. Use a long random value such as the output of `openssl rand -hex 32`, and keep a copy. Stored keys cannot be read without it.

There are no sign-in attempt limits, so use a long random password. Then open `https://ai-gateway.<your-subdomain>.workers.dev/admin` and sign in with any username and the password. A fresh deployment can take a minute to respond.

[DEPLOY.md](DEPLOY.md) is the full step-by-step guide, including custom domains, deploying from GitHub, rollbacks and troubleshooting.

## Create a key

1. Pick a provider preset, or choose Custom endpoint and enter the provider's base URL as its docs give it (for example `https://api.example.com/v1`). Choose the header the provider expects the key in.
2. Enter the real key and an expiry.
3. Optionally click Load models from provider and tick the models to allow, and set any limits.
4. Create the key. Up to 20 can be made at once with the same settings.

Each key row has Edit, Duplicate (reuses the real key), Share link, Reset usage and Revoke. Revoking takes up to a minute to reach every Cloudflare location.

Share link creates a link that reveals the key once, after a button press, so chat link previews cannot use it up. It lasts 24 hours or until the key expires.

## Use a key

OpenAI-style clients use the base URL `https://<worker>/v1` and the gateway key in place of the real one. The key is accepted as `Authorization: Bearer`, `x-api-key`, `api-key`, `x-goog-api-key` or `?key=`.

Claude Code, with a provider that has an Anthropic-compatible API (Anthropic, OpenRouter), goes in `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "<gateway key>",
    "ANTHROPIC_BASE_URL": "https://<worker>",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

Errors from the gateway itself:

| Status | Meaning |
|---|---|
| 401 | Unknown, revoked or expired key |
| 403 | Model not allowed, wrong IP, or outside the time window |
| 429 | Spend cap, token cap or rate limit reached |
| 502 | Provider unreachable |

A rerouted request's response has an `x-gateway-downgrade` header, for example `claude-opus-5-5 -> claude-sonnet-5-5`.

## Costs

Successful calls to `/v1/messages`, `/v1/chat/completions` and `/v1/responses` are metered from the response's token counts. Prices are set in the admin page's Prices table, in USD per million tokens. The defaults are Anthropic's list prices for current Claude models, checked on 2026-10-12. A row matches any model whose name contains it, and the longest match wins. Import OpenRouter prices fills in every OpenRouter model, and for OpenRouter keys the cost OpenRouter reports is used directly. Models with no price are counted in tokens only.

Caps are checked before each request, so calls already running can go slightly over. Only the three endpoints above count toward a cap: calls such as embeddings, images, audio, batches or Gemini's native `generateContent` pass through unmetered, and a spend cap does not limit models with no price (use a token cap or a model allowlist for those). Set a credit limit with the provider as well.

## Admin sign-in

Under Sign-in, add a passkey (fingerprint, face, phone or security key). From then on the password no longer works and sessions last 12 hours. On Linux, choose "use a phone" when the browser asks. Add two passkeys so losing one does not lock you out. A passkey only works on the address it was created on.

If every passkey is lost, run `npx wrangler secret put ALLOW_PASSWORD`, enter `true`, sign in with the password and add a new passkey. Then run `npx wrangler secret delete ALLOW_PASSWORD`.

## Free plan limits

| Resource | Free allowance per day | Used by |
|---|---|---|
| Worker requests | 100,000 | every call |
| KV reads | 100,000 | every call |
| KV writes | 1,000 | creating or editing keys, expiry |
| Durable Object requests | 100,000 | metered calls, and calls on keys with caps or rate limits |

Each request may make 50 subrequests, so the admin page lists and creates keys 20 at a time. Metering is kept within the 10 ms CPU limit per request.

## Maintenance

| Task | Command |
|---|---|
| Update | `git pull`, then `npm run deploy` |
| Change a secret | `npx wrangler secret put ADMIN_PASSWORD` (or `ENCRYPTION_KEY`) |
| Remove everything | `npx wrangler delete`, then delete the KV namespace in the dashboard under Storage & Databases > KV |

Changing `ENCRYPTION_KEY` makes existing keys unreadable until you enter their real key again with Edit. Keys created before `ENCRYPTION_KEY` was set stay unencrypted until edited.

## Security notes

- Real keys are encrypted with AES-GCM and tied to their gateway key. They are never sent to the browser.
- Client IP headers, cookies, origin and the gateway key are stripped before forwarding, and upstream redirects are not followed.
- The admin API only accepts changes sent as JSON, which other websites cannot send with your login, and the admin page cannot be embedded in other sites.

## Development

```
npm test
```

Tests run on Node.js 22.15+ with no dependencies. `npx wrangler dev` runs the worker locally; put `ADMIN_PASSWORD` and `ENCRYPTION_KEY` in a `.dev.vars` file.

## License

MIT
