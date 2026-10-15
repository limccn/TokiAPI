# TokiAPI

![TokiAPI](doc/banner.png)

[![CI](https://github.com/limccn/TokiAPI/actions/workflows/ci.yml/badge.svg)](https://github.com/limccn/TokiAPI/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**[中文](README.md) | English**

**A self-hosted, OpenAI-compatible AI API gateway — one entry point that proxies multiple model vendors, 100% on Cloudflare, with no external services.**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/limccn/TokiAPI)

## What is this

Converge multiple model vendors (OpenAI-compatible APIs and the Anthropic native format) into a single unified entry point: your application keeps using the official SDKs and only points its base URL at the gateway. The gateway handles authentication with its own issued API keys, prepaid pay-per-use billing, rate limiting and caching, and provides a web admin console for usage reports, keys, members and model pricing.

## Who is it for / What can it do

For individuals and teams who want to manage multiple model vendors in one place — especially if you are moving an existing OpenAI / Anthropic application to a self-hosted entry point, or need to hand out rate-limited keys to members with pay-per-use billing:

- One entry point for multiple models (OpenAI compatible + Anthropic native format)
- Nearly zero application-side changes: only switch the SDK's base URL, and change only the `model` parameter to switch models
- Team keys: issue a key per person, each individually rate-limited and revocable at any time
- Prepaid balance, billed per token; failed requests are never charged
- Built-in rate limiting and response caching: over-quota requests are rejected automatically, repeated requests are faster and cheaper
- Web admin console: view usage reports; manage keys, members and model prices
- Data and keys stay in your own Cloudflare account (self-hosted)

## Quick start

### Option 1: one-click deploy (recommended)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/limccn/TokiAPI)

Click the button and Cloudflare clones the repository into your account, auto-provisions the D1 / KV / Queues resources declared in `wrangler.jsonc` (real resource ids are written back into your copy of the config), and hands builds and releases to Workers Builds. Secrets and personalized values are entered on the setup page (the keys listed in `.dev.vars.example`).

**Prerequisites**:

- A Cloudflare account on the **Workers Paid plan** — the billing/usage async pipeline uses Queues, which fails to bind on the free plan
- (Optional) A GitHub OAuth App: needed only for GitHub sign-in (which is also **the only entry point for the first admin** — see the checklist below); skip it if you only use email/password + invite codes

### Option 2: manual deploy

```bash
git clone <your-repo-url> tokiapi && cd tokiapi
npm install
cp .dev.vars.example .dev.vars   # local dev values (local real secrets; deploys use secret put — see below)
```

Create the real resources first and write their ids back into `wrangler.jsonc` (the placeholder ids in the committed form are for local development only):

```bash
npx wrangler d1 create cf-ai-gateway-db          # database_id → wrangler.jsonc
npx wrangler kv namespace create CACHE_KV        # id → wrangler.jsonc
npx wrangler queues create cf-ai-gateway-usage   # Queues require Workers Paid
npx wrangler queues create cf-ai-gateway-billing
```

Then one command builds, migrates, and deploys:

```bash
npm run deploy               # scripts/deploy.mjs: build → d1 migrations (remote) → wrangler deploy
npm run deploy -- --dry-run  # preview mode: builds only, then prints the selected config and the remote commands
```

Config selection rule (scripts/deploy.mjs): if **`wrangler.prod.jsonc`** exists at the repo root (the maintainer fork: real domain routes + real resource ids + personalized vars; gitignored, never committed) it is used; otherwise **`wrangler.jsonc`** (the button / open-source form). Once a maintainer puts production values into the fork file, `npm run deploy` picks it up automatically — a foolproofing semantic: accidentally overwriting the real production worker's bindings with the button form's placeholder ids is structurally impossible.

## Post-deployment checklist (first admin and basic setup)

Right after deployment the system is in a safe state: zero users, every policy switch off. Do the following in order:

1. **Database migrations** (mandatory for one-click deploys; manual `npm run deploy` already includes this):
   ```bash
   npx wrangler d1 migrations apply DB --remote
   ```
2. **Fix the site URL**: `BETTER_AUTH_URL` in `wrangler.jsonc` defaults to `http://localhost:5173`. For one-click deploys, change it in Dashboard → Workers → your Worker → Settings → Variables and Secrets to the real origin (e.g. `https://<worker>.<subdomain>.workers.dev`); maintainer forks edit `wrangler.prod.jsonc` directly. If left wrong, admin-console requests get 301-redirected to `https://localhost/...`.
3. **Write the secrets** (any subset of the four):
   ```bash
   npx wrangler secret put BETTER_AUTH_SECRET     # session signing key (random, ≥32 chars)
   npx wrangler secret put GATEWAY_SECRET_KEY     # upstream-key encryption key (random, ≥32 chars, must differ from the one above)
   npx wrangler secret put GITHUB_CLIENT_SECRET   # only when GitHub sign-in is enabled
   npx wrangler secret put RESEND_API_KEY         # only when email verification / transactional mail is enabled
   ```
4. **GitHub OAuth App** (the only entry point for the first admin): GitHub → Settings → Developer settings → OAuth Apps → New; the callback URL must exactly equal `https://<your origin>/api/auth/callback/github`. Replace the `replace-me-github-client-id` placeholder with the Client ID (one-click deploys: Dashboard vars), write the Client Secret as in step 3, and add your email to `GITHUB_ALLOWED_EMAILS` (comma-separated; **empty = all GitHub logins rejected**).
5. **First admin**: sign in with a whitelisted GitHub account, then promote it to admin (**the only legitimate bootstrap; never INSERT a user with SQL** — Better Auth's hashing/bindings would be bypassed):
   ```bash
   npx wrangler d1 execute DB --remote \
     --command "UPDATE users SET role='admin' WHERE email='you@example.com';"
   ```
6. **Generate invite codes**: sign in to the admin console → invites page → create invite links; members open a link and register with email and password.
7. **Configure vendors and pricing**: admin console → providers (enter each vendor's API key; stored AES-GCM-encrypted, masked in responses); configure the model price table row by row in the console, or load the default price list with `npx wrangler d1 execute DB --remote --file=./seed.sql` (**full-replace** semantics — use with care if you already configured prices).

## Where configuration lives

| Form | File | Purpose |
| --- | --- | --- |
| Committed | `wrangler.jsonc` | Button / open-source form: resource bindings (placeholder ids, rewritten by one-click deploy) + `[vars]` safe defaults + no custom-domain routes |
| Local values | `.dev.vars` (gitignored, copied from `.dev.vars.example`) | Local values for the real secrets + local `[vars]` overrides (**local dev only**) |
| Maintainer fork | `wrangler.prod.jsonc` (gitignored, never committed) | Production deploy: real domain routes + real resource ids + personalized vars |

**Real secrets** (**never** into any config file or the repo; write each with `wrangler secret put`; one-click deploys enter them on the setup page):

- `BETTER_AUTH_SECRET`, `GATEWAY_SECRET_KEY` — both required (the latter encrypts upstream vendor keys; generate independent random values, they must differ)
- `GITHUB_CLIENT_SECRET` — only when GitHub sign-in is enabled
- `RESEND_API_KEY` — only when email verification / transactional mail is enabled

**`[vars]` runtime values** (`wrangler.jsonc` ships safe defaults; personalized values follow the checklist above):

| Key | Default | Description |
| --- | --- | --- |
| `BETTER_AUTH_URL` | `http://localhost:5173` | Full platform URL — **must be changed to the real origin in production** (the default 301-redirects the admin console to localhost) |
| `GITHUB_CLIENT_ID` / `GITHUB_ALLOWED_EMAILS` | placeholder / empty | GitHub sign-in (optional); an empty whitelist = all logins rejected (fail-closed) |
| `API_DOMAIN` | empty | Dual-domain split switch (empty = off — the correct form for a single workers.dev domain) |
| `API_KEY_PREFIX` / `REQUEST_LOG_RETENTION_DAYS` | `sk-` / `30` | Gateway key prefix / request-log retention in days |
| `CACHE_ENABLED`, `EMAIL_VERIFICATION_ENABLED` and other policy switches | all off | Default = off (fail-closed); enable as needed |

Authoritative per-key comments live in `wrangler.jsonc` and `.dev.vars.example`; the full three-category runtime config rules are in [CLAUDE.md](CLAUDE.md) §环境与配置.

## Integration examples

Official SDKs need only two changes: point the base URL at the gateway, and use a key created in the gateway:

```ts
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: "sk-…",                          // gateway API key
  baseURL: "https://<gateway>/v1",         // only this line changes
});

const completion = await openai.chat.completions.create({
  model: "gpt-…",                          // any model configured in the gateway
  messages: [{ role: "user", content: "hi" }],
});
```

```ts
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: "sk-…",                          // gateway API key
  baseURL: "https://<gateway>/anthropic",  // only this line changes
});

const message = await anthropic.messages.create({
  model: "claude-…",                       // any model configured in the gateway
  max_tokens: 1024,
  messages: [{ role: "user", content: "hi" }],
});
```

Both authentication headers (`Authorization: Bearer` and Anthropic's native `x-api-key`) are accepted by the gateway. See [CLAUDE.md](CLAUDE.md) for full protocols and endpoints.

## Run locally

**Requirements**: Node.js ≥ 20 and npm; no Cloudflare account is needed for local development.

```bash
git clone <your-repo-url> tokiapi
cd tokiapi
npm install

# 1. Create the local values file from the committed template (gitignored)
cp .dev.vars.example .dev.vars   # at minimum fill BETTER_AUTH_SECRET / GATEWAY_SECRET_KEY

# 2. Prepare the local database
npm run db:migrate     # apply migrations
npm run db:seed        # seed the default model price table (idempotent)

# 3. Start the dev server
npm run dev            # http://localhost:5173
```

Local dev reads `wrangler.jsonc` (bindings and `[vars]` safe defaults) + `.dev.vars` (local overrides). GitHub OAuth is optional — the gateway runs without configuring it. Database commands reference the binding name (`DB`) and pin the config file to `wrangler.jsonc` explicitly.

**Where the first account comes from**: email/password registration requires an invite code, and the first admin has no code-issuing entry point yet — locally and in production it is the same path: GitHub OAuth. Configure `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_ALLOWED_EMAILS` (your own email) in `.dev.vars`, sign in, then promote yourself to admin:

```bash
npx wrangler d1 execute DB --local --config wrangler.jsonc \
  --command "UPDATE users SET role='admin' WHERE email='you@example.com';"
```

Once an admin is signed in, they can generate invite links in the admin console; members open a link and register with email and password.

## Self-hosting and technical docs

- **Deployment essentials** (the maintainer fork, the `--dry-run` does-not-validate-resources pitfall, resource naming, rollback) → [CLAUDE.md](CLAUDE.md) (Chinese) §部署要点
- **API reference / common commands / tests & acceptance / project structure** → [CLAUDE.md](CLAUDE.md) (Chinese)

## License

MIT, see [LICENSE](LICENSE).
