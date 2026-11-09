<p align="center">
  <img src="doc/icon-256.png" width="128" height="128" alt="TokiAPI" />
</p>

<h1 align="center">TokiAPI</h1>

<p align="center">
  <strong>One OpenAI-compatible API for every model vendor — self-hosted on Cloudflare.</strong>
</p>

<p align="center">
  <a href="https://github.com/limccn/TokiAPI/actions/workflows/ci.yml"><img src="https://github.com/limccn/TokiAPI/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/limccn/TokiAPI/releases"><img src="https://img.shields.io/github/v/release/limccn/TokiAPI?sort=semver&amp;style=flat-square&amp;label=release" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/limccn/TokiAPI?style=flat-square" alt="License: MIT" /></a>
  <a href="https://github.com/limccn/TokiAPI/stargazers"><img src="https://img.shields.io/github/stars/limccn/TokiAPI?style=flat-square" alt="GitHub stars" /></a>
  <a href="https://github.com/limccn/TokiAPI/commits/develop"><img src="https://img.shields.io/github/last-commit/limccn/TokiAPI?style=flat-square" alt="Last commit" /></a>
  <a href="https://workers.cloudflare.com/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&amp;logo=cloudflare&amp;logoColor=white" alt="Cloudflare Workers" /></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/limccn/TokiAPI"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" /></a>
  <a href="https://appflare.dev/install/?repo=limccn/TokiAPI"><img src="https://appflare.dev/badge.svg" alt="Install with Appflare" /></a>
</p>

---

TokiAPI is a self-hosted AI API gateway. It puts **one OpenAI-compatible endpoint** in front of many
model vendors — OpenAI-compatible and Anthropic-native — so your applications use one base URL and one
key, while you keep usage, keys, balances and prices in one console.

The core runs entirely on Cloudflare (Workers, D1, KV, Queues). Email verification and SMS sign-in are
**optional** integrations with Resend and Alibaba Cloud; leave them unconfigured and the gateway runs
without them.

## Contents

- [Why TokiAPI?](#why-tokiapi)
- [Try the hosted instance](#try-the-hosted-instance)
- [Quick start](#quick-start)
- [After deployment: the checklist](#after-deployment-the-checklist)
- [Key variables you must get right](#key-variables-you-must-get-right)
- [Configuration reference](#configuration-reference)
- [External services](#external-services)
- [Phone gate](#phone-gate)
- [Connect your app](#connect-your-app)
- [How it works](#how-it-works)
- [Admin console](#admin-console)
- [Repository layout](#repository-layout)
- [FAQ and troubleshooting](#faq-and-troubleshooting)
- [Contributing and security](#contributing-and-security)
- [License](#license)

## Why TokiAPI?

- **One endpoint, many vendors.** Register any number of upstream providers, then switch models by
  changing only the `model` parameter.
- **Drop-in for the official SDKs.** Point the OpenAI or Anthropic SDK at the gateway; no protocol
  translation in your application code.
- **Works with coding agents.** Claude Code, Codex CLI, CC Switch and other OpenAI/Anthropic-compatible
  tools can use the gateway directly.
- **Team keys.** Issue a key per person or per app, limit its rate, and revoke it at any time.
- **Prepaid billing.** Per-token pricing with a visible balance; failed requests are not charged.
- **Rate limits and response cache.** Over-quota requests are rejected automatically; repeated
  non-streaming requests can be served from the edge.
- **Admin console.** Usage reports, keys, members, providers, model prices and account settings in one
  place.
- **Your data stays in your account.** Users, keys, prices, balances and request logs live in your own
  Cloudflare D1/KV resources.

## Try the hosted instance

A hosted instance runs at **<https://tokiapi.app>**, with the API at
**<https://api.tokiapi.app/v1>** (OpenAI-compatible) and **<https://api.tokiapi.app/anthropic>**
(Anthropic-native).

Email/password and phone registration require an invite code; GitHub sign-in is open. The instance is
intended for evaluation: there is no SLA, capacity is limited, and you should not send sensitive data
through a shared instance.

To request an invite, open an issue with the dedicated form:

**[Request an invite](https://github.com/limccn/TokiAPI/issues/new?template=invite-request.yml)**

The form asks for:

- What you want to use it for
- Which models or providers you plan to use
- Your expected monthly volume
- A confirmation that you will use it fairly and not resell it

You can also copy this template into a new issue:

```text
What I want to use it for:
Models / providers I plan to use:
Expected monthly volume:
Anything else:
```

Please do **not** include phone numbers, passwords, API keys or other secrets in the issue.

## Quick start

| I want to… | Start here |
| --- | --- |
| Try it without deploying anything | [Try the hosted instance](#try-the-hosted-instance) |
| Deploy my own instance | [One-click deploy](#option-a-one-click-deploy-recommended) |
| Run it locally or contribute | [Local development](#option-c-local-development) |

### Option A: one-click deploy (recommended)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/limccn/TokiAPI)

Cloudflare clones the repository into your account and provisions the D1, KV and Queues resources
declared in `wrangler.jsonc` (real resource ids are written back into your copy). Builds and releases
are handled by Workers Builds. Secrets and personalized values are entered on the setup page.

**Prerequisites**

- A Cloudflare account. The **free plan works**: Queues is available on Free and Paid, with a daily
  operation allowance. Check the current Cloudflare limits if you expect heavy traffic.
- *(Optional)* A GitHub OAuth App — needed for GitHub sign-in, which is also the bootstrap path for
  the first administrator.
- *(Optional)* Resend and/or Alibaba Cloud accounts if you want email verification or SMS sign-in.

**Steps**

1. Click the Deploy button and complete the Cloudflare setup flow.
2. Enter the secrets you need on the setup page. At minimum, generate two independent random values:
   `BETTER_AUTH_SECRET` and `GATEWAY_SECRET_KEY`.
3. Set `BETTER_AUTH_URL` to the real origin of your deployment (for example
   `https://<worker-name>.<your-subdomain>.workers.dev`) — not the localhost default.
4. Wait for the first Workers Builds deployment to finish.
5. Apply the database migrations **once** (one-click deploy does **not** run them automatically).
   Run this from a clone of the repository copy Cloudflare created in your account; the upstream
   repository still has placeholder resource ids:

   ```bash
   npx wrangler d1 migrations apply DB --remote
   ```

6. Continue with [After deployment: the checklist](#after-deployment-the-checklist).

> **Alternative:** [Appflare](https://appflare.dev) is a third-party platform that installs a manager
> Worker into your Cloudflare account. Its install flow provisions resources, applies migrations and
> fills in the site URL automatically. The repository-build form may require a paid Workers plan; see
> Appflare's documentation for the current requirements.

### Option B: manual deploy

Use this path if you prefer to create resources yourself or deploy from your own machine.

```bash
git clone https://github.com/limccn/TokiAPI.git tokiapi
cd tokiapi
npm install
```

Create the resources and write the real ids back into `wrangler.jsonc` (the committed ids are
placeholders for local development and for the Deploy button). Resource names must match the
`name` / `database_name` / `queue` values declared in `wrangler.jsonc`; if you rename a resource,
update `wrangler.jsonc` to match:

```bash
# Replace each <...> with the corresponding name from wrangler.jsonc.
npx wrangler d1 create <database-name>          # database_id → wrangler.jsonc
npx wrangler kv namespace create CACHE_KV        # id → wrangler.jsonc
npx wrangler queues create <usage-queue>
npx wrangler queues create <billing-queue>
```

If you rename the billing queue, update `BILLING_QUEUE_NAME` as well — dispatch matches queue names
exactly.

Create a local values file from the committed template:

```bash
cp .dev.vars.example .dev.vars
```

Then build, migrate and deploy with one command:

```bash
npm run deploy               # build → remote D1 migrations → wrangler deploy
npm run deploy -- --dry-run  # preview: build only, print the selected config and remote commands
```

`scripts/deploy.mjs` uses `wrangler.prod.jsonc` if it exists (a gitignored maintainer fork), otherwise
`wrangler.jsonc`. You do not need to create a fork for a normal deployment.

### Option C: local development

**Requirements:** Node.js 20 or newer and npm. No Cloudflare account is needed.

```bash
git clone https://github.com/limccn/TokiAPI.git tokiapi
cd tokiapi
npm install

cp .dev.vars.example .dev.vars   # fill BETTER_AUTH_SECRET and GATEWAY_SECRET_KEY at minimum
npm run db:migrate               # apply migrations to the local D1
npm run db:seed                  # load the default model price table
npm run dev                      # http://localhost:5173
```

Local development reads `wrangler.jsonc` for bindings and safe defaults, plus `.dev.vars` for local
overrides. GitHub OAuth is optional locally.

**Where the first admin comes from (local and production):** email/password registration needs an
invite code, and the first administrator has no invite page yet. Use GitHub OAuth. Put your own email
in `ADMIN_EMAILS`, configure `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, and sign in — the account is
promoted automatically. If the email is not listed, promote it manually after signing in:

```bash
npx wrangler d1 execute DB --local --config wrangler.jsonc \
  --command "UPDATE users SET role='admin' WHERE email='you@example.com';"
```

Never create users with `INSERT` SQL; that bypasses Better Auth's password hashing and account
bindings.

## After deployment: the checklist

The system starts in a safe state: zero users, every policy switch off. Work through these steps in
order.

### 1. Apply database migrations

One-click deploy does not run them; manual `npm run deploy` already does. For one-click deployments,
run this from a clone of the repository copy in your account (the upstream repo has placeholder ids).

```bash
npx wrangler d1 migrations apply DB --remote
```

**Verify:** the command reports applied migrations without errors.

### 2. Set the site URL

In Dashboard → Workers & Pages → your Worker → Settings → Variables and Secrets, set
`BETTER_AUTH_URL` to the real origin (for example `https://<worker-name>.<your-subdomain>.workers.dev`).
If you use a maintainer fork, edit `wrangler.prod.jsonc` instead.

**Why:** the default `http://localhost:5173` makes admin-console requests redirect to
`https://localhost/...`. API traffic may still work, which makes this easy to miss.

**Verify:** open the console, sign in, and confirm the browser stays on your real origin.

### 3. Write the required secrets

```bash
npx wrangler secret put BETTER_AUTH_SECRET     # session signing key, random, ≥ 32 characters
npx wrangler secret put GATEWAY_SECRET_KEY     # upstream-key encryption key, random, ≥ 32 characters
```

Generate the two values independently. `GATEWAY_SECRET_KEY` encrypts upstream provider keys; never
reuse `BETTER_AUTH_SECRET`.

Add the optional secrets only when you enable the corresponding feature:

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET   # GitHub sign-in
npx wrangler secret put RESEND_API_KEY         # email verification (Resend)
npx wrangler secret put SMS_ACCESS_KEY_ID      # SMS sign-in (Alibaba Cloud)
npx wrangler secret put SMS_ACCESS_KEY_SECRET
```

### 4. Create a GitHub OAuth App and bootstrap the first admin

1. GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**.
2. Set the callback URL exactly to `https://<your-origin>/api/auth/callback/github`.
3. Put the Client ID in `GITHUB_CLIENT_ID` (Dashboard variable or `wrangler.jsonc`), and the Client
   Secret in the `GITHUB_CLIENT_SECRET` secret.
4. Put your own email in `ADMIN_EMAILS` (comma-separated; Dashboard variable or `wrangler.jsonc`).
5. Sign in with GitHub. The account is promoted to admin automatically.

If the email is not in `ADMIN_EMAILS`, promote the account manually:

```bash
npx wrangler d1 execute DB --remote \
  --command "UPDATE users SET role='admin' WHERE email='you@example.com';"
```

`ADMIN_EMAILS` promotes on sign-up and sign-in and never demotes. **Once your administrators exist,
clear the list** — an empty list means nobody is promoted automatically. Read
[Key variables you must get right](#key-variables-you-must-get-right) before clearing it if you use
SMS sign-in.

### 5. Create invite codes

Sign in to the console and open the Invites page. Generate an invite link and send it to a member.
With SMS enabled, registration is a three-screen flow: invite code + phone code → username and
password → optional email binding. With SMS disabled, registration uses email and password — that
flow still requires an invite code. GitHub sign-up is open and does not need one.

### 6. Add providers and model prices

Console → **Providers**: add each upstream vendor and its API key. Keys are encrypted with AES-GCM and
masked in responses. Console → **Models**: add the model names your applications will send, or load the
default price list:

```bash
npx wrangler d1 execute DB --remote --file=./seed.sql
```

`seed.sql` uses full-replace semantics; use it only before you have configured your own prices.

### 7. Smoke test

```bash
curl https://<your-origin>/api/health
curl https://<your-origin>/v1/models -H "Authorization: Bearer sk-..."
```

A healthy instance returns `200` for the health check and a model list for an authenticated key.

### 8. Optional: enable email verification (Resend)

See [Email with Resend](#email-with-resend). Keep this off until the Resend domain is verified and
`EMAIL_FROM` points at that domain.

### 9. Optional: enable SMS sign-in (Alibaba Cloud)

See [SMS with Alibaba Cloud](#sms-with-alibaba-cloud). Configure the credentials, sign name, templates
and test allowlist **before** setting `SMS_AUTH_ENABLED=true`, because the switch also enables the
[phone gate](#phone-gate).

## Key variables you must get right

### `BETTER_AUTH_URL`

The full origin of the platform (console) domain, for example `https://tokiapi.example.com`.

- In production it must be the real origin. The localhost default causes a 301 redirect to
  `https://localhost/...` for management pages.
- The GitHub OAuth callback must use the same origin:
  `https://<origin>/api/auth/callback/github`.
- If you use a separate API domain, set `API_DOMAIN` as well (see the configuration table).

### `ADMIN_EMAILS`

A comma-separated list of email addresses that become administrators automatically on sign-up or
sign-in.

- **Empty = nobody is promoted automatically.** Sign-in itself is not restricted by this list.
- Promotion is one-way: an account that is promoted stays an admin even if you remove the entry.
- The list is a **bootstrap tool**, not a permanent role store. Once your admins exist, clear it.
- If `SMS_AUTH_ENABLED=true`, the list also grants an exemption from the phone gate — but only when the
  account's email is verified. Clearing the list removes that exemption too. Before clearing it, make
  sure every administrator has a verified phone number, or keep the list until they do. Once the list
  is cleared, an admin without a verified phone can still reach `/bind-phone`, but other `/api/*`
  calls return `403`.

### `SMS_ALLOWED_PHONES`

A comma-separated allowlist of phone numbers that may receive SMS codes.

- Accepted forms: `+8613800138000` or `13800138000`. Spaces and dashes are tolerated.
- **Empty = allow every number.** Anyone who can reach the send-code endpoint can then trigger a
  paid SMS to any valid number.
- **Non-empty but all invalid = deny everyone** (fail-closed); it does not silently fall back to
  “allow all”.
- A number outside the list is skipped **silently**: the endpoint may report success while no message
  is sent. Put your test numbers in the list before testing.
- Recommended rollout: start with a test allowlist → verify delivery → either keep a team allowlist or
  clear it intentionally.

### `EMAIL_ALLOWED_RECIPIENTS`

A comma-separated allowlist for transactional email.

- **Empty = allow every recipient** (the same semantics as the SMS list, not the opposite).
- Non-empty = only listed addresses receive mail.
- Only relevant when `EMAIL_VERIFICATION_ENABLED=true`. During testing, set it to your own address.

## Configuration reference

### Secrets

Never put these in a config file, a README or source. Use `wrangler secret put` (or the one-click
setup page).

| Secret | Required | Purpose |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Yes | Signs sessions. Random, ≥ 32 characters. |
| `GATEWAY_SECRET_KEY` | Yes | Encrypts upstream provider keys. Random, ≥ 32 characters, different from the auth secret. |
| `GITHUB_CLIENT_SECRET` | Only for GitHub sign-in | GitHub OAuth App client secret. |
| `RESEND_API_KEY` | Only for email | Resend API key; a send-only key is recommended. |
| `SMS_ACCESS_KEY_ID` | Only for SMS | Alibaba Cloud RAM AccessKey ID. |
| `SMS_ACCESS_KEY_SECRET` | Only for SMS | Alibaba Cloud RAM AccessKey secret. |

### Runtime variables

The committed `wrangler.jsonc` ships safe defaults. Change personalized values in the Dashboard, in
`wrangler.prod.jsonc` (maintainer fork), or in `.dev.vars` (local only).

| Variable | Default | What it does |
| --- | --- | --- |
| `BETTER_AUTH_URL` | `http://localhost:5173` | Platform origin. **Must be changed in production.** |
| `GITHUB_CLIENT_ID` | placeholder | GitHub OAuth App client id. |
| `ADMIN_EMAILS` | empty | Emails auto-promoted to admin. Empty = no automatic promotion. Clear after bootstrap. |
| `API_DOMAIN` | empty | Separate API domain for the dual-domain split. Empty = single domain. |
| `API_KEY_PREFIX` | `sk-` | Prefix for newly generated gateway keys. |
| `REQUEST_LOG_RETENTION_DAYS` | `30` | Days to keep request-log rows; a daily cron cleans them up. |
| `CACHE_ENABLED` | `false` | Global response-cache switch. |
| `BILLING_QUEUE_NAME` | `<billing-queue>` | Must match the billing queue name in `wrangler.jsonc` — change both together if you rename the queue; advanced. |
| `SIGNUP_BONUS_AMOUNT` | `5` | Bonus (USD) granted when a phone number is verified. `0` disables. |
| `EMAIL_VERIFY_BONUS_AMOUNT` | `5` | Bonus granted when an email is verified/bound. `0` disables. |
| `GITHUB_BIND_BONUS_AMOUNT` | `5` | Bonus granted when GitHub is linked after registration. `0` disables. |
| `EMAIL_VERIFICATION_ENABLED` | `false` | Enables email verification and the email-binding bonus. Does not block sign-in. |
| `EMAIL_ALLOWED_RECIPIENTS` | empty | Email allowlist. **Empty = allow all.** |
| `EMAIL_FROM` | empty | Sender address for transactional email. Empty = the built-in `notify@tokiapi.app` (hosted instance only). Set this for self-hosting. |
| `EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED` | `false` | Allows email-registered accounts to be promoted to admin through the users API. Does not affect `ADMIN_EMAILS`. |
| `SMS_AUTH_ENABLED` | `false` | Enables phone-number sign-in/registration and the phone gate. Off = endpoints return 404 and phone UI is hidden. |
| `SMS_ALLOWED_PHONES` | empty | SMS allowlist. **Empty = allow all**; all-invalid = deny all. |
| `SMS_SIGN_NAME` | empty | Alibaba Cloud SMS sign name. |
| `SMS_TEMPLATE_CODE` | empty | Template code for sign-in/sign-up/binding. The gifted templates are `100001`–`100005`. |
| `SMS_TEMPLATE_CODE_RESET` | empty | Template code for password reset. Empty = reuse `SMS_TEMPLATE_CODE`; `100003` is recommended. |
| `SMS_TEMPLATE_PARAM` | `{"code":"##code##","min":"5"}` | Maps template variables. `##code##` is replaced with the real code. |
| `MODELCAP_BASE_TOKENS` | `8192` | Advanced: model-cap grid baseline. |
| `MODELCAP_MULTIPLIER` | `2` | Advanced: model-cap multiplier. |

Authoritative per-key comments also live in `wrangler.jsonc` and `.dev.vars.example`.

## External services

Both integrations are optional. If you leave them unconfigured, the gateway keeps working and simply
does not send email or SMS. The failure modes are deliberately quiet so that a missing optional
integration never blocks core proxying — but that also means you should test after configuring.

### Email with Resend

Use this for email verification and the email-binding bonus. It does **not** block sign-in.

1. Create a [Resend](https://resend.com) account.
2. Add the domain you want to send from and add the DNS records Resend shows you. Wait until the
   domain is verified.
3. Create an API key with **sending** permission only.
4. Write the key:

   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```

5. Set `EMAIL_FROM` to an address on your verified domain, for example
   `notify@mail.example.com`. If you leave it empty, the built-in default is
   `notify@tokiapi.app`, which only works on the hosted instance.
6. Set `EMAIL_VERIFICATION_ENABLED=true`.
7. *(Recommended during testing)* Set `EMAIL_ALLOWED_RECIPIENTS` to your own address. Empty means
   every recipient is allowed.

**How to verify:** bind an email in the console, or use the resend-verification action, and confirm the
message arrives. Check the Worker logs for:

| Log event | Meaning |
| --- | --- |
| `email_not_configured` | `RESEND_API_KEY` is empty; the channel is dormant. |
| `email_skipped_allowlist` | The recipient is not in `EMAIL_ALLOWED_RECIPIENTS`. |
| `email_sent` | Resend accepted the message. |
| `email_send_failed` | Resend rejected the message (domain, key or payload). |

**Common problems**

- **No email at all:** the key is missing, the domain is not verified, or the recipient is outside the
  allowlist.
- **Resend rejects the sender:** `EMAIL_FROM` is still the built-in `notify@tokiapi.app` and your
  Resend account does not own that domain.
- **Resend sandbox:** `onboarding@resend.dev` can only send to the Resend account owner's address. For
  real users, verify your own domain.

### SMS with Alibaba Cloud

Use this for phone-number sign-in, phone registration, phone binding and password reset. The gateway
uses **Alibaba Cloud SMS Verification** (`dypnsapi`), not the older SMS service (`dysmsapi`).

**Prerequisites**

- A real-name-verified Alibaba Cloud account.
- The **SMS Verification** service activated in the console.
- A RAM user with the single permission `dypns:SendSmsVerifyCode` (least privilege), and an AccessKey
  for that user.
- A sign name and a template code. The console provides five gifted templates; availability depends on
  your account and region. If they are not available, apply for a template with the same variables.

1. Create the RAM user and AccessKey. Do not use your root account AccessKey.
2. Write the credentials:

   ```bash
   npx wrangler secret put SMS_ACCESS_KEY_ID
   npx wrangler secret put SMS_ACCESS_KEY_SECRET
   ```

3. Copy the **sign name** from the console into `SMS_SIGN_NAME`.
4. Set `SMS_TEMPLATE_CODE` to one of the gifted templates:

   | Code | Best for |
   | --- | --- |
   | `100001` | Sign-in / sign-up / generic |
   | `100002` | Change the bound phone |
   | `100003` | Reset password |
   | `100004` | Bind a new phone |
   | `100005` | Verify an already-bound phone |

   The templates differ only in wording; all use `${code}` and `${min}`. Set
   `SMS_TEMPLATE_CODE_RESET=100003` for password reset (empty = reuse the main template).
5. If your template uses different variable names, change the keys in `SMS_TEMPLATE_PARAM`. The
   default is `{"code":"##code##","min":"5"}`; `##code##` is replaced with the real code.
6. Put a test number in `SMS_ALLOWED_PHONES`, for example `+8613800138000`. Do not leave the allowlist
   empty while testing unless you intend to allow every number.
7. Set `SMS_AUTH_ENABLED=true` **last**. This also enables the [phone gate](#phone-gate).
8. Request a code from the login page and confirm it arrives.

**Limits**

- Mainland-China `+86` numbers only; templates are in Chinese.
- One message per number per 60 seconds.
- A code is valid for 5 minutes and allows 3 attempts.
- Alibaba Cloud bills per message; gifted templates and quotas are shown in its console.

**How to verify / troubleshoot**

| Log or error | Meaning |
| --- | --- |
| `sms_not_configured` | `SMS_ACCESS_KEY_ID` or `SMS_ACCESS_KEY_SECRET` is empty; sends are skipped. |
| `sms_skipped_allowlist` | The number is not in `SMS_ALLOWED_PHONES`; no message is sent. |
| `SMS_CONFIG_INVALID` | `SMS_SIGN_NAME`, `SMS_TEMPLATE_CODE` or `SMS_TEMPLATE_PARAM` is missing/invalid. |
| `ILLEGAL_MOBILE` | The number is not a valid mainland-China mobile number. |
| `biz.FREQUENCY` | The same number requested a code within 60 seconds. |
| `SMS_SEND_FAILED` | Network or signing failure; check the AccessKey and system time. |

> **Configure before you flip the switch.** If `SMS_AUTH_ENABLED=true` but the AccessKey is missing,
> the endpoints are enabled while every send is silently skipped. If the allowlist excludes a number,
> the UI may say the code was sent while nothing arrives. Test with a listed number first.

## Phone gate

When `SMS_AUTH_ENABLED=true`, accounts without a verified phone are restricted:

- They can reach the `/bind-phone` page, `GET /api/me/profile` and `POST /api/me/password`.
- Every other gated `/api/*` call returns `403` with `code: "PHONE_BINDING_REQUIRED"`. Public routes
  mounted before the gate — `/api/auth/*`, `/api/health`, `/api/config` and `/api/invites/*` — stay
  reachable.
- `/v1/*` and `/anthropic/*` proxying is **not** affected.
- Accounts listed in `ADMIN_EMAILS` **whose email is verified** are exempt. An unverified email does
  not qualify, and clearing `ADMIN_EMAILS` removes the exemption.
- Turning `SMS_AUTH_ENABLED` back to `false` removes the gate and makes the phone endpoints return
  `404` again; this is the rollback path.

If you enable SMS on an existing deployment, plan for existing members: they will be asked to bind a
phone on their next visit. Make sure the phone allowlist includes their numbers (or is empty), and make
sure administrators can bind before you clear `ADMIN_EMAILS`.

## Connect your app

Create a gateway key in the console (Keys → Create key). The full key is shown only once.

### OpenAI SDK

```ts
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: "sk-…",                          // gateway API key
  baseURL: "https://<gateway>/v1",         // only this line changes
});

const completion = await openai.chat.completions.create({
  model: "gpt-…",                          // a model configured in the gateway
  messages: [{ role: "user", content: "hi" }],
});
```

### Anthropic SDK

```ts
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: "sk-…",                          // gateway API key
  baseURL: "https://<gateway>/anthropic",  // only this line changes
});

const message = await anthropic.messages.create({
  model: "claude-…",                       // a model configured in the gateway
  max_tokens: 1024,
  messages: [{ role: "user", content: "hi" }],
});
```

Both `Authorization: Bearer` and Anthropic's native `x-api-key` header are accepted.

### Endpoints

| Endpoint | Protocol | Notes |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions | Streaming and non-streaming. |
| `POST /v1/completions` | OpenAI | Text completions. |
| `POST /v1/embeddings` | OpenAI | Embeddings. |
| `POST /v1/responses` | OpenAI Responses | Streaming SSE without a `[DONE]` terminator. |
| `POST /v1/messages` | Auto-detected | Anthropic Messages or OpenAI Chat Completions, detected per request. |
| `GET /v1/models` | OpenAI | Models configured in the gateway. |
| `POST /anthropic/v1/messages` | Anthropic Messages | Target for the official Anthropic SDK. |
| `POST /anthropic/messages` | Anthropic Messages | Alias for SDKs whose base URL has no path suffix. |

Error shapes follow the entry protocol: OpenAI-style `{ "error": { "message": … } }` on `/v1/*`
(except `/v1/messages`, whose errors follow the protocol detected for that request), and
Anthropic-style `{ "type": "error", "error": { … } }` on `/anthropic/*`.

The model name in your request must exactly match a model configured in the console. For Claude Code,
Codex CLI and CC Switch configuration snippets, open `/docs` on your deployment.

## How it works

```text
Client (OpenAI / Anthropic SDK, coding agent)
        │
        ▼
Cloudflare Worker (Hono)
  ├── gateway key auth ──► D1 (users, keys, balances, prices, usage)
  ├── rate limiting ─────► KV counters
  ├── response cache ────► KV
  ├── provider router ───► OpenAI-compatible / Anthropic upstreams
  └── usage accounting ──► Queues (usage + billing aggregation)
```

- **D1** stores users, gateway keys, providers, model prices, balances, transactions and request logs.
- **KV** holds rate-limit counters and the optional response cache.
- **Queues** aggregate usage and billing asynchronously; the console reflects usage after the queue
  consumer catches up.
- A daily cron removes request-log rows older than `REQUEST_LOG_RETENTION_DAYS`.

**Data boundary:** prompts and responses are sent to the upstream providers you configure. Everything
else — accounts, keys, prices, balances and logs — stays in your Cloudflare account. Resend receives
the email address and verification content; Alibaba Cloud receives the phone number and verification
code. No analytics or telemetry is sent anywhere by the gateway.

## Admin console

The hosted instance at <https://tokiapi.app> shows the current console.

- **Dashboard** — balance, spend, requests and token usage.
- **API Keys** — create, inspect and revoke gateway keys.
- **Billing** — balance and transaction history.
- **Usage** — usage by key, model and time range.
- **Providers** — upstream vendors and encrypted API keys.
- **Models** — model names, prices, free/visible flags.
- **Users** — members, roles, invites, bonuses and bound login methods.
- **Settings** — runtime defaults and policy switches currently in effect (read-only; change them in Cloudflare).

## Repository layout

```text
src/                 Worker backend (Hono): routes, middleware, billing, providers
app/                 React SPA: admin console, public pages, docs page
drizzle/             D1 migrations (append-only)
tests/               Vitest + Miniflare test suite
scripts/             Deploy runner, E2E probes and fixtures
seed.sql             Default model price table (full replace; see step 6)
doc/                 README artwork and console screenshot
wrangler.jsonc       Committed deploy config: placeholder ids + safe defaults
README.md            English README (this file)
README.zh-CN.md      Chinese README
CLAUDE.md            Deeper engineering notes for maintainers (Chinese)
```

## FAQ and troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The console redirects to `https://localhost/...` | `BETTER_AUTH_URL` is still the default | Set it to the real origin and redeploy. |
| `403 PHONE_BINDING_REQUIRED` | SMS is enabled and the account has no verified phone | Open `/bind-phone`; admins with a verified email in `ADMIN_EMAILS` are exempt. |
| `401` from `/v1/*` | Missing, wrong or revoked gateway key | Check the `Authorization: Bearer sk-…` header; create a new key. |
| `404` on phone endpoints | `SMS_AUTH_ENABLED` is not `true` | Enable SMS only after the credentials and templates are configured. |
| Email never arrives | Resend key missing, domain unverified, or recipient outside the allowlist | Check the logs and the Resend dashboard. |
| SMS never arrives | AccessKey missing, number outside `SMS_ALLOWED_PHONES`, template/sign invalid, or 60-second limit | Check logs; put the test number in the allowlist first. |
| “Invalid, used or expired invite code” | The invite was consumed or expired | Ask an admin for a new invite. |
| Usage or billing does not update immediately | Queue consumer is catching up, or the queue name is misconfigured | Check the Queues dashboard and `BILLING_QUEUE_NAME`. |
| `npm run deploy` uses the wrong config | A `wrangler.prod.jsonc` fork exists | Run `npm run deploy -- --dry-run` to see the selected config. |
| `wrangler deploy --dry-run` passes but the deploy fails | Dry-run does not validate that queues/resources exist | Create the resources in your account first. |
| How do I update? | — | Manual deploy: `git pull`, then `npm run deploy`. Workers Builds: push or merge to the branch it tracks. |
| How do I roll back? | — | `npx wrangler rollback`; migrations are append-only, so never edit an applied migration. |
| Do I need a custom domain? | — | No; `*.workers.dev` works. Set `BETTER_AUTH_URL` to that origin. |
| Is the free plan enough? | — | Usually for small teams; check current Cloudflare Queues limits for your volume. |

## Contributing and security

Issues and pull requests are welcome. Before sending a change:

```bash
npm run lint
npm run typecheck
npm test -- --maxWorkers=2
npm run build
```

The full test suite needs `--maxWorkers=2` because parallel Miniflare isolates can exhaust memory.

Please do not paste API keys, phone numbers, email addresses or other personal data into issues. For a
security report, use GitHub's private security advisories instead of a public issue:
<https://github.com/limccn/TokiAPI/security/advisories/new>.

## License

MIT — see [LICENSE](LICENSE).
