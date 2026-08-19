# Wis.ai

A personal assistant, hired the way you'd hire one in the real world.

This repository holds both the specification and the application built from
it. The spec is authoritative: where code and spec disagree, the spec is the
bug report.

## Contents

### Specification

- [`docs/SPEC.md`](docs/SPEC.md), the full product and technical specification
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), the Cloudflare-native system architecture
- [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md), visual language and component rules
- [`docs/CONTENT_AND_TONE.md`](docs/CONTENT_AND_TONE.md), writing rules that apply everywhere
- [`design/tokens.json`](design/tokens.json) / [`design/tokens.css`](design/tokens.css), design tokens
- [`CONTRIBUTING.md`](CONTRIBUTING.md), repository and review conventions

### Application

```
src/
  index.ts              Worker entry: routing, API, inbound email handler
  agent/
    user-agent.ts       Durable Object, one per user (Agents SDK)
    context.ts          Context assembly, the single place that owns what the model sees
    prompts.ts          Base system prompt and the per-user personality layer
    untrusted.ts        The untrusted-content boundary (SPEC 9.4)
  routes/
    auth.ts             Email one-time-code auth (SPEC 2)
    onboarding.ts       The onboarding conversation (SPEC 3)
    app.ts              The signed-in surface
    cards.ts            Secure user cards (SPEC 7)
  channels/
    webhooks.ts         WhatsApp and Telegram inbound
    linking.ts          Pairing tokens, QR, implicit mobile verification (SPEC 4.3)
    outbound.ts         Delivery, including the one-active-channel rule (SPEC 4.2)
  workflows/
    task.ts             Every agentic task, with its fallback chain (SPEC 10)
    config.ts           Task-type config, externalised to D1 (SPEC 10.3)
  lib/
    models.ts           The two model tiers, both through AI Gateway (SPEC 8)
site/                   Static marketing site, served by the same Worker
migrations/             D1 schema
test/                   Boundary and tone invariants
```

## Running it

```bash
npm install
npx wrangler d1 migrations apply wis --local
npm run dev
```

Workers AI, Vectorize and Browser Run have no local simulation, so those three
bindings talk to the real services even in `wrangler dev`. Everything else is
simulated locally.

```bash
npm test        # boundary and tone invariants
npm run typecheck
npm run deploy
```

## Deployed resources

| Concern | Resource |
|---|---|
| Worker | `wis`, routed on `wis.ai/*` |
| Structured data | D1 `wis` |
| Short-lived tokens | KV `WIS_KV` |
| Files and recordings | R2 `wis-files` |
| Semantic memory | Vectorize `wis-memory`, 768 dims, cosine |
| Per-user runtime | Durable Object `UserAgent` |
| Task execution | Workflow `wis-task` |

## Configuration

Model tiers are environment variables, never hardcoded (SPEC 8). Change either
value in `wrangler.jsonc` and redeploy to move a tier to a newer model.

| Var | Purpose |
|---|---|
| `REASONING_MODEL` | Conversation, planning, anything acting on the user's behalf |
| `ROUTER_MODEL` | Routing, classification, injection screening, narration wording |
| `EMBEDDING_MODEL` | Semantic memory embeddings |
| `AI_GATEWAY_ID` | The AI Gateway all model calls route through |

Secrets are set with `wrangler secret put` and are all optional. Each feature
that needs one degrades visibly rather than failing at startup.

| Secret | Unlocks |
|---|---|
| `EMAIL_API_TOKEN` | Sending mail to any recipient. Without it, only verified destination addresses are reachable. |
| `ANTHROPIC_API_KEY` | The reasoning tier. Without it, that tier falls back to `ROUTER_MODEL`. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` | Telegram |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_NUMBER`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | WhatsApp |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` | Payment cards |

## Connecting WhatsApp and Telegram

Both webhooks are already deployed and live. Neither needs a code change, only
credentials and a registration step on the provider's side.

| Endpoint | Method | Purpose |
|---|---|---|
| `https://wis.ai/webhooks/telegram` | POST | Telegram updates |
| `https://wis.ai/webhooks/whatsapp` | GET | Meta's subscription handshake |
| `https://wis.ai/webhooks/whatsapp` | POST | Inbound messages |

Both verify the caller before doing any work: Telegram by the secret token it
echoes in `X-Telegram-Bot-Api-Secret-Token`, WhatsApp by an HMAC-SHA256 check
of `X-Hub-Signature-256` against the app secret. Until the corresponding secret
is set, that check is skipped, so set the secrets before registering.

### Telegram

1. Message [@BotFather](https://t.me/BotFather), `/newbot`, and note the token
   and the bot username.
2. Set the secrets. `TELEGRAM_WEBHOOK_SECRET` is any random string you choose.

   There is nowhere in Telegram to type it. BotFather creates bots and issues
   tokens; it has no webhook settings at all. A webhook can only be registered
   through the Bot API's `setWebhook` method, and the secret is a parameter of
   that same call. Step 3 makes that call, which is what puts the URL and the
   secret on Telegram's side in one go. Until it runs, Telegram has nowhere to
   deliver to, so the bot chat opens and nothing else happens.

   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_BOT_USERNAME
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```

3. Register the webhook. The script prompts for what it needs, hides the
   input, and keeps it out of your shell history:

   ```bash
   ./scripts/register-telegram-webhook.sh
   ```

   Leave the secret prompt blank if the Worker does not have
   `TELEGRAM_WEBHOOK_SECRET` set. It must be set on both sides or neither:
   a secret on one side only means Telegram delivers, the Worker rejects
   every update, and nothing happens with no error anywhere.

`TELEGRAM_BOT_USERNAME` is what builds the `t.me/<bot>?start=<token>` deep link
on the Connect button, so linking shows nothing useful until it is set. A leading
`@` is stripped, since BotFather usually shows the username with one.

Setting the secrets and registering the webhook are two separate things, and
only the second one involves Telegram. The secrets tell the Worker what to do
with updates; registration tells Telegram where to send them. Doing the first
without the second is the most likely reason a bot appears connected but never
replies. `/app` says so when it detects it, and `GET /api/diagnostics` reports
whether each channel has ever called and what happened when it did.

### WhatsApp

Uses the Meta Cloud API.

1. In the Meta developer dashboard, create an app, add the WhatsApp product,
   and note the phone number ID, the business phone number, a permanent access
   token, and the app secret.
2. Set the secrets. `WHATSAPP_VERIFY_TOKEN` is a random string you choose and
   then type into Meta's webhook form.

   ```bash
   npx wrangler secret put WHATSAPP_TOKEN
   npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
   npx wrangler secret put WHATSAPP_NUMBER
   npx wrangler secret put WHATSAPP_VERIFY_TOKEN
   npx wrangler secret put WHATSAPP_APP_SECRET
   ```

3. In the dashboard, configure the webhook with callback URL
   `https://wis.ai/webhooks/whatsapp`, the same verify token, and subscribe to
   the `messages` field. Meta calls the GET endpoint to confirm; it answers the
   challenge once `WHATSAPP_VERIFY_TOKEN` matches.

### Checking it worked

Sign in, open `/app`, and press Connect. That issues a single-use pairing token
(15 minutes) and renders a deep link and QR code. Opening it starts a chat
pre-filled with `link <token>`, and the Worker binds that channel identity to
the account. If the channel's phone number matches the one on the account,
`mobile_verified` flips to true; if it does not, the assistant asks once
whether to update it (SPEC 4.3).

With both linked, only the active channel receives assistant-initiated
messages, so nothing is sent twice. Replies work on either (SPEC 4.2).

## Outstanding manual steps

These need account-level access that the Workers OAuth token does not carry.

1. **Create the AI Gateway** named `wis`. Until it exists, model calls still
   work but bypass the gateway, and each bypass logs an error. SPEC 8.3
   requires every call to route through it.
2. **Create an API token with Email Sending permission** and set it as the
   `EMAIL_API_TOKEN` secret. Email Sending is enabled on the account and
   `wis.ai` is onboarded, but the two send paths do not have the same reach:
   the REST API sends to any recipient, while the `send_email` Workers binding
   refuses any destination that is not a verified address in the account.
   Sign-in codes go to people typing their address for the first time, so the
   REST path is the only workable one. Without the token, auth mail falls back
   to the binding and only reaches verified addresses.
3. **Add MX records for `me.wis.ai`** so each assistant's own inbox receives
   mail (SPEC 6.1 keeps it on a separate subdomain from auth mail, so a spam
   complaint against one assistant cannot damage deliverability of sign-in
   codes). Sending from the subdomain is already onboarded, and Cloudflare has
   created its `cf-bounce` MX, SPF, DKIM and DMARC records. Receiving needs the
   subdomain added under Email Routing settings, which creates the MX records
   pointing at `route1/2/3.mx.cloudflare.net`. Until then, mail to
   `{handle}@me.wis.ai` is not delivered anywhere.
4. **Replace the `*.wis.ai` wildcard with explicit records.** The wildcard
   answers every name, including a TXT record returning `v=spf1 -all` for any
   subdomain without one of its own. That is what made `_dmarc.wis.ai` appear
   misconfigured, and it will shadow any DKIM or DMARC record that is ever
   missed. It also makes unused names resolve and fail with a TLS error rather
   than not resolving at all. Removing it needs a check for anything currently
   depending on it.
5. **Attach `wis.ai` and `www.wis.ai` as Worker custom domains.** This
   replaces hand-managed records with ones Cloudflare creates and maintains,
   and is the explicit alternative to the wildcard. It is blocked while a
   wildcard or manual A record covers the hostname, so the wildcard has to go
   first.
6. **Configure a credential vault** before enabling credential cards. Those
   cards fail closed while it is unset, which is deliberate: better to tell the
   user it did not save than to put a raw credential somewhere it does not
   belong (SPEC 7.2).
7. **Set `ANTHROPIC_API_KEY`** to run the reasoning tier on the model SPEC 8
   specifies. Without it that tier degrades to `ROUTER_MODEL`, which is a much
   smaller model doing work the spec reserves for the strongest available one.

## What is structural but not yet capable

`docs/ARCHITECTURE.md` lists a browsing agent, voice calls and outbound mail as
task methods. The Workflow that sequences them is built and working; the
capability behind most of them is not.

| Method | Today |
|---|---|
| `api` | Reports unavailable. Nothing is wired up, which is the significant gap: SPEC 10.1 puts a direct API first in the chain, so every request currently falls through to browsing. |
| `browser` | Loads and extracts real pages, and that part works. Finding pages does not: search engines serve a bot challenge to Browser Rendering's addresses, so generic web search is unavailable. Useful only when pointed at a known URL. |
| `voice` | Reports unavailable. |
| `email` | Reports unavailable. Outbound mail works (see `lib/email.ts`) but is not wired to a task method. |

What this means in practice: a reservation task tries `api`, misses, notifies
the user it is switching to browsing, gets the stub's canned reply, and ends
`partial`. That is the specified shape (SPEC 10.1) running correctly over
methods that cannot yet do the work.

What is genuinely built and verified is the structure SPEC 10 fixes: the
ordered chain read from `task_type_config` in D1, a notification before every
transition, durable retries with backoff, and a terminal outcome that always
carries next options. Adding real capability means filling in `attemptBrowser`
and its siblings in `src/workflows/task.ts`; none of the surrounding structure
has to change, which is the point of keeping them as seams.

Anything a browser returns is external content and must go back through
`wrapUntrusted` (SPEC 9.4) before it reaches the reasoning model, and a booking
or purchase found that way still needs the user's confirmation. Both are
requirements of that section, not optional hardening.

## Known spec deviations

- `docs/SPEC.md` section 8 names `@cf/qwen/qwen3-30b-a3b` as the router
  default. That id does not exist in the Workers AI catalog. The deployed
  value is `@cf/qwen/qwen3-30b-a3b-fp8`, the same model in the form Cloudflare
  actually serves. This is the one-line config change SPEC 8.2 anticipates.
