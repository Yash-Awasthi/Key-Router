# Key Router

A Cloudflare Worker that wraps a provider key (OpenAI-compatible ones such as OpenRouter, DeepSeek, Groq and Zhipu, plus Anthropic, Azure OpenAI and Gemini) in a disposable gateway key with an expiry. Clients only ever see the gateway key; the worker swaps in the real key and forwards the request, streaming included.

## Deploying to your own Cloudflare account

Everything runs on the Cloudflare free plan. No server or credit card is needed, and your computer can be switched off once it is deployed.

### What you need

- A free Cloudflare account ([sign up](https://dash.cloudflare.com/sign-up))
- [Node.js](https://nodejs.org) 22 or newer
- [Git](https://git-scm.com)

### Steps

1. Get the code:

   ```
   git clone https://github.com/Yash-Awasthi/Key-Router.git
   cd Key-Router
   ```

2. Deploy:

   ```
   npm run setup
   ```

   This walks through everything:

   - A browser window opens asking you to log in to Cloudflare and allow access. Approve it and return to the terminal.
   - On a brand-new account, you are asked to pick a `workers.dev` subdomain. It becomes part of your URL.
   - The KV store that holds keys is created automatically.
   - The worker is deployed and its URL is printed, for example `https://ai-gateway.<your-subdomain>.workers.dev`.
   - Finally you are asked for an admin password. Choose a long one; it protects the admin page.

3. Open `https://ai-gateway.<your-subdomain>.workers.dev/admin`, sign in with any username and the password from step 2, and create your first key.

The first request to a fresh deployment can return a Cloudflare error for up to a minute while the URL propagates.

### Changing things later

| Task | How |
|---|---|
| Update to the latest version | `git pull` then `npm run deploy` |
| Change the admin password | `npx wrangler secret put ADMIN_PASSWORD`, or the worker's Variables and Secrets in the dashboard |
| Use a different worker name | `npx wrangler deploy --name <name>`, then run `npx wrangler secret put ADMIN_PASSWORD --name <name>` |
| Deploy to another Cloudflare account | `npx wrangler logout`, then `npm run setup` |
| Remove everything | `npx wrangler delete`, then delete the KV namespace under Storage & Databases > KV in the dashboard |

Keys live in each account's own KV store, so keys made on one deployment do not work on another.

## Creating keys

Open `https://<worker>.workers.dev/admin` and sign in with the admin password (the username is ignored). Then enter:

- the provider's base URL exactly as its docs give it (for example `https://openrouter.ai/api/v1`)
- the real API key
- how the provider expects the key: `Authorization: Bearer` (most providers), `x-api-key` (Anthropic), `api-key` (Azure) or `x-goog-api-key` (Gemini). The page picks this for you for known hosts.
- an expiry

Optional settings per key:

- a label, to tell keys apart
- a spend cap in USD; once the key's metered spend reaches it, requests get `429`
- a requests-per-minute limit; extra requests get `429`
- an allowed-model list; requests for any other model get `403`. A trailing `*` matches a prefix, so `claude-haiku-*` allows every Haiku model.

The page returns the endpoint and gateway key to hand out. Keys expire on their own, and Extend moves the expiry of an active key.

## Client configuration

OpenAI-compatible clients set their base URL to `https://<worker>.workers.dev/v1` and send the gateway key as `Authorization: Bearer`, `x-api-key`, `api-key` or `x-goog-api-key`. The gateway answers CORS preflight requests, so browser apps can call it directly.

Claude Code works when the provider exposes an Anthropic-compatible endpoint (OpenRouter does). The admin page prints a ready-to-paste `~/.claude/settings.json` after each key is created:

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "<gateway key>",
    "ANTHROPIC_BASE_URL": "https://<worker>.workers.dev",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "allow": [],
    "deny": []
  }
}
```

The base URL has no `/v1`; Claude Code appends `/v1/messages` itself.

## Cost tracking

Every successful `POST` to `/v1/messages`, `/v1/chat/completions` or `/v1/responses` is metered. The worker reads the model and token counts from the response (streamed or not), prices Claude models at Anthropic's list rates for Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5 (including cache reads and 5-minute and 1-hour cache writes), and adds them to a per-key total. The admin page shows each key's spend per model.

- Totals are kept in a Durable Object per key, so concurrent requests never lose updates. Revoking a key deletes its totals.
- Streamed Chat Completions only report usage when the provider sends it; add `"stream_options": {"include_usage": true}` to the request if yours does not by default.
- The spend cap is checked before each request, so requests already in flight when the cap is reached can take spend slightly past it. Unpriced models do not count toward the cap.
- Prices live in `PRICES` in `worker.js`. Other models are counted by tokens and shown as unpriced.
- Figures are list-price estimates. Discounts, batch pricing and fast mode are not modelled, so treat them as a monitor, not an invoice.

## Revoking

Use the Revoke button on the admin page, or delete the entry under Storage & Databases > KV in the Cloudflare dashboard. Revocation can take up to a minute to reach every edge location.

When a key expires, the real provider key is erased from storage. The gateway key stays listed as expired for 30 days so its spend can still be read, then it is removed along with its totals.

## Limits

The Workers free plan allows 100,000 requests per day per account, shared by all of its workers, and resets at 00:00 UTC. Each proxied call uses one request and one KV read; metered calls also make one Durable Object request, and keys with a spend cap or rate limit make one more. Malformed keys are rejected before any KV read. Workers Paid raises this to 10 million per month.

The gateway does not cap spend, so set credit limits on the provider side. Real keys are stored in Workers KV and are never returned by the admin API.

## Tests

```
npm test
```

## License

MIT
