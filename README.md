# Key Router

A Cloudflare Worker that wraps any OpenAI-compatible provider key (OpenRouter, DeepSeek, Groq, Zhipu, and so on) in a disposable gateway key with an expiry. Clients only ever see the gateway key; the worker swaps in the real key and forwards the request, streaming included.

## Deploying to any Cloudflare account

```
git clone https://github.com/Yash-Awasthi/Key-Router.git
cd Key-Router
npm run setup
```

Setup logs in to Cloudflare if needed, creates the KV store automatically, deploys, and asks for the admin password. To target a different account, run `npx wrangler logout` first. If the worker name is already taken, deploy with `npx wrangler deploy --name <name>`.

Keys live in each account's own KV store, so keys made on one deployment do not work on another. The admin password can later be changed in the Cloudflare dashboard under the worker's Variables and Secrets.

## Creating keys

Open `https://<worker>.workers.dev/admin` and sign in with the admin password (the username is ignored). Then enter:

- the provider's base URL exactly as its docs give it (for example `https://openrouter.ai/api/v1`)
- the real API key
- an expiry

The page returns the endpoint and gateway key to hand out. Keys expire on their own.

## Client configuration

OpenAI-compatible clients set their base URL to `https://<worker>.workers.dev/v1` and send the gateway key as `Authorization: Bearer` or `x-api-key`.

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

## Revoking

Use the Revoke button on the admin page, or delete the entry under Storage & Databases > KV in the Cloudflare dashboard. Revocation can take up to a minute to reach every edge location.

## Limits

The Workers free plan allows 100,000 requests per day per account, shared by all of its workers, and resets at 00:00 UTC. Each proxied call uses one request and one KV read. Workers Paid raises this to 10 million per month.

The gateway does not cap spend, so set credit limits on the provider side. Real keys are stored in Workers KV and are never returned by the admin API.

## Tests

```
npm test
```

## License

MIT
