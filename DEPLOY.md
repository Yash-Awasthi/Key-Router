# Deploying Key Router to Cloudflare Workers

This guide takes you from nothing to a running gateway at `https://ai-gateway.<your-subdomain>.workers.dev`, then covers custom domains, updates, monitoring and troubleshooting. Everything fits in the Cloudflare free plan.

## 1. What gets created

| Resource | Name | Purpose |
|---|---|---|
| Worker | `ai-gateway` | Serves the admin page and proxies API calls |
| KV namespace | bound as `KEYS` | Stores gateway keys, encrypted real keys and prices |
| Durable Object `Meter` | bound as `METER` | Per-key usage, spend caps and rate limits |
| Durable Object `Admin` | bound as `ADMIN` | Passkeys and admin sessions |
| Secret | `ADMIN_PASSWORD` | Admin sign-in until a passkey is added |
| Secret | `ENCRYPTION_KEY` | Encrypts real provider keys at rest |

The KV namespace is created automatically on first deploy because `wrangler.toml` gives no `id` for it. Both Durable Objects use the SQLite backend, which is the only kind the free plan allows.

## 2. Prerequisites

- A Cloudflare account. Sign up at https://dash.cloudflare.com/sign-up.
- Node.js 22 or newer (`node --version`).
- Git.

On first use of Workers, Cloudflare asks you to choose a `workers.dev` subdomain. Do this in the dashboard under Workers & Pages, or accept Wrangler's prompt during the first deploy.

## 3. Get the code

```
git clone https://github.com/Yash-Awasthi/Key-Router.git
cd Key-Router
npm test
```

All tests should pass before you deploy.

## 4. Log in to Cloudflare

```
npx wrangler login
npx wrangler whoami
```

`login` opens a browser to authorise Wrangler. `whoami` should print your account. If you have several accounts, set the one to use:

```
export CLOUDFLARE_ACCOUNT_ID=<account id>        # macOS / Linux
$env:CLOUDFLARE_ACCOUNT_ID = "<account id>"      # Windows PowerShell
```

On a server or in CI, where no browser is available, create an API token instead (dashboard > My Profile > API Tokens > "Edit Cloudflare Workers" template) and set `CLOUDFLARE_API_TOKEN` along with `CLOUDFLARE_ACCOUNT_ID`.

## 5. Choose the worker name (optional)

The name in `wrangler.toml` decides the URL:

```toml
name = "ai-gateway"
```

Change it before the first deploy if you want a different address. Renaming later creates a second, separate worker with empty storage.

## 6. Deploy

```
npx wrangler deploy
```

Wrangler bundles `worker.js` with the HTML pages, creates the KV namespace, applies the Durable Object migrations and prints the worker URL. A brand-new `workers.dev` address can take a minute before it answers.

## 7. Set the secrets

Generate an encryption key and keep a copy somewhere safe, such as a password manager:

```
openssl rand -hex 32
```

Without `openssl`, any 64-character random hex string works, for example from `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

Use a long random value for `ADMIN_PASSWORD` too: the admin page does not limit sign-in attempts. Then store both secrets. Each command prompts for the value, so it never lands in shell history:

```
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put ADMIN_PASSWORD
```

Secrets take effect immediately; no redeploy is needed.

Set `ENCRYPTION_KEY` before creating any keys. Keys created without it are stored unencrypted until edited. If you lose it, every stored real key becomes unreadable and must be re-entered with Edit.

`npm run setup` runs steps 6 and 7 in one go.

## 8. First sign-in

1. Open `https://ai-gateway.<your-subdomain>.workers.dev/admin`.
2. Sign in with any username and the `ADMIN_PASSWORD` value.
3. Under Sign-in, add a passkey, then a second one as a backup. From this point the password stops working.
4. Under Sign-in, confirm the page reports encryption as enabled.

Passkeys are tied to the address they were created on. If you plan to use a custom domain (next section), set it up first and register passkeys there.

## 9. Custom domain (optional)

The domain's DNS must be on Cloudflare. Add to `wrangler.toml`:

```toml
routes = [
  { pattern = "gateway.example.com", custom_domain = true }
]
```

Run `npx wrangler deploy` again. Cloudflare creates the DNS record and certificate. To stop serving on `workers.dev` as well, add `workers_dev = false`.

The same can be done in the dashboard under Workers & Pages > ai-gateway > Settings > Domains & Routes.

## 10. Check it works

Create a gateway key in the admin page, then call the gateway with it. For an OpenAI-style provider:

```
curl https://ai-gateway.<your-subdomain>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer sk-gw-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"<allowed model>","messages":[{"role":"user","content":"hi"}]}'
```

For Anthropic:

```
curl https://ai-gateway.<your-subdomain>.workers.dev/v1/messages \
  -H "x-api-key: sk-gw-..." \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"<allowed model>","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```

A normal model reply means the key, routing and upstream are all working. The key's usage should appear in the admin page and at `/usage`.

## 11. Deploying from GitHub (optional)

To redeploy on every push, connect the repository in the dashboard: Workers & Pages > ai-gateway > Settings > Build > Connect, choose the repository and branch, and leave the deploy command as `npx wrangler deploy`. Secrets stay as set in step 7. Add `npm test` as the build command so a failing test blocks the deploy.

## 12. Running locally

Create `.dev.vars` (already git-ignored):

```
ADMIN_PASSWORD=local-password
ENCRYPTION_KEY=<any 64-char hex>
```

Then run `npx wrangler dev` and open `http://localhost:8787/admin`. Local KV and Durable Object data live in `.wrangler/` and never touch production.

## 13. Day-to-day operations

| Task | Command |
|---|---|
| Update to latest code | `git pull`, `npm test`, `npx wrangler deploy` |
| Watch live logs | `npx wrangler tail` |
| List deployed versions | `npx wrangler deployments list` |
| Roll back the last deploy | `npx wrangler rollback` |
| Rotate the admin password | `npx wrangler secret put ADMIN_PASSWORD` |
| List secrets | `npx wrangler secret list` |
| Recover after losing all passkeys | `npx wrangler secret put ALLOW_PASSWORD` with value `true`, sign in, add a passkey, then `npx wrangler secret delete ALLOW_PASSWORD` |
| Remove everything | `npx wrangler delete`, then delete the KV namespace under Storage & Databases > KV |

Rollback restores code only. KV data, Durable Object data and secrets are not rolled back.

Usage against the free plan limits is shown in the dashboard under Workers & Pages > ai-gateway > Metrics. The limits are listed in the README.

## 14. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `You need to register a workers.dev subdomain` | Pick one in the dashboard under Workers & Pages, then deploy again. |
| `In order to use Durable Objects with a free plan, you must create a namespace using a new_sqlite_classes migration` | The migrations in `wrangler.toml` were edited. Restore them; never change or remove an applied migration tag. |
| `More than one account available` | Set `CLOUDFLARE_ACCOUNT_ID` (step 4). |
| Admin page shows a Cloudflare 1101 error | The worker threw. Run `npx wrangler tail` and reload to see the error. |
| Every call returns 401 | The gateway key is wrong, revoked or expired, or it was revoked less than a minute ago at another location. |
| Calls return 502 | The provider's base URL is wrong or the provider is down. Check the key's endpoint in Edit. |
| Stored keys stopped working after a secret change | `ENCRYPTION_KEY` changed. Put the old value back, or re-enter each real key with Edit. |
| Passkey prompt fails | You are on a different address from the one the passkey was made on. Use the original address, or use the `ALLOW_PASSWORD` recovery above. |
| `Error 1027` or requests start failing late in the day | A daily free-plan limit was reached. It resets at 00:00 UTC, or move to the Workers Paid plan. |
