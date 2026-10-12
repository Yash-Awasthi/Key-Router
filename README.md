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

Open `https://<worker>.workers.dev/admin` and sign in with the admin password (the username is ignored). Then:

1. Pick a provider. Presets fill in the base URL and auth header for Anthropic, OpenAI, Google Gemini, DeepSeek, xAI, Mistral, Groq, Cerebras, Together AI, Fireworks AI, Moonshot, Zhipu, Alibaba Qwen, Cohere and OpenRouter. For anything else choose Custom endpoint and enter the base URL exactly as the provider's docs give it; the real key can be sent as `Authorization: Bearer` (most providers), `x-api-key` (Anthropic), `api-key` (Azure) or `x-goog-api-key` (Gemini).
2. Enter the real API key and an expiry, and optionally a label.
3. Optionally restrict models: Load models from provider lists everything the provider's `<base>/models` endpoint returns for that key, and the boxes you tick become the only models the gateway key may use. Extra patterns take names by hand, and a trailing `*` matches a prefix (`claude-haiku-*`). With nothing ticked and no patterns, every model is allowed.
4. Optionally set limits, all empty by default:
   - Spend cap in USD and token cap (input plus output tokens), counted over the key's lifetime or per calendar month (UTC). Once reached, requests get `429`.
   - Requests per minute; extra requests get `429`.
   - Max output tokens per request. Larger `max_tokens`, `max_completion_tokens` or `max_output_tokens` values are lowered to it, and Chat Completions and Responses calls that set none get it added.
   - Allowed client IPs, as addresses or CIDR ranges, IPv4 or IPv6. Calls from anywhere else get `403`.

The page returns the endpoint and gateway key to hand out. Edit changes any setting of an active key, including its expiry, endpoint and real key (leave the key empty to keep it). Duplicate starts a new key with the same settings and, unless you enter another, the same real key. Reset usage clears a key's totals so its caps count from zero. Keys expire on their own.

A key with a model list also gets a filtered `GET /v1/models`, so clients only see the models they may use.

## Client configuration

OpenAI-compatible clients set their base URL to `https://<worker>.workers.dev/v1` and send the gateway key as `Authorization: Bearer`, `x-api-key`, `api-key`, `x-goog-api-key` or a `?key=` query parameter. The query parameter is removed before the request is forwarded. The gateway answers CORS preflight requests, so browser apps can call it directly.

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

Every successful `POST` to `/v1/messages`, `/v1/chat/completions` or `/v1/responses` is metered. The worker reads the model and token counts from the response (streamed or not), prices them, and adds them to the key's lifetime and monthly totals. The admin page shows each key's spend per model, and Export usage CSV downloads every key's usage by month and model.

Prices are edited in the Prices section of the admin page. A row prices every model whose name contains its text, with dots treated as dashes, so `claude-opus-5-5` also prices `anthropic/claude-opus-5.5`; the longest matching row wins. Each row has input, output, cache-read and 5-minute and 1-hour cache-write rates in USD per million tokens, plus optional long-context and fast-mode multipliers. The defaults are Anthropic's list prices for current Claude models, checked against the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing) on 2026-10-12, including Claude Haiku 5.5's 5x rates for prompts over 100,000 tokens, fast mode, and the 1.1x US data residency multiplier. Models without a matching row are counted by tokens and shown as unpriced. Restore defaults puts the list prices back.

- Totals are kept in a Durable Object per key, so concurrent requests never lose updates. Revoking a key deletes its totals.
- A request is priced when it finishes, so editing prices does not change earlier totals.
- Streamed Chat Completions only report usage when the provider sends it; add `"stream_options": {"include_usage": true}` to the request if yours does not by default.
- Caps are checked before each request, so requests already in flight when a cap is reached can go slightly past it. Unpriced models count toward the token cap but not the spend cap.
- Figures are list-price estimates. Discounts and batch pricing are not modelled, so treat them as a monitor, not an invoice.

## Revoking

Use the Revoke button on the admin page, or delete the entry under Storage & Databases > KV in the Cloudflare dashboard. Revocation can take up to a minute to reach every edge location.

When a key expires, the real provider key is erased from storage. The gateway key stays listed as expired for 30 days so its spend can still be read, then it is removed along with its totals.

## Limits

The Workers free plan allows 100,000 requests per day per account, shared by all of its workers, and resets at 00:00 UTC. Each proxied call uses one request and one KV read; metered calls also make one Durable Object request, and keys with a cap or rate limit make one more. Listing keys on the admin page reads each key once. Malformed keys are rejected before any KV read. Workers Paid raises this to 10 million per month.

The gateway does not cap spend, so set credit limits on the provider side. Real keys are stored in Workers KV and are never returned by the admin API.

## Tests

```
npm test
```

## License

MIT
