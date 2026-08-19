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
3. **Fix the DMARC record.** `_dmarc.wis.ai` currently contains
   `v=spf1 -all`, which is an SPF value in a DMARC record and is not a valid
   policy. Email Sending expects `v=DMARC1; p=reject;`. The MX, SPF and DKIM
   records for sending were created automatically and are correct.
4. **Add MX and SPF records for `me.wis.ai`** so each assistant's own inbox
   works (SPEC 6.1 keeps it on a separate subdomain from auth mail so a spam
   complaint against one assistant cannot damage deliverability of account
   mail). Three MX records at priorities 49, 63 and 99 pointing at
   `route1.mx.cloudflare.net`, `route2.mx.cloudflare.net` and
   `route3.mx.cloudflare.net`, plus an SPF TXT record of
   `v=spf1 include:_spf.mx.cloudflare.net ~all`.
5. **Point `www.wis.ai` at the Worker.** It currently resolves to parking IPs
   outside Cloudflare. The apex is live.
6. **Configure a credential vault** before enabling credential cards. Those
   cards fail closed while it is unset, which is deliberate: better to tell the
   user it did not save than to put a raw credential somewhere it does not
   belong (SPEC 7.2).
7. **Set `ANTHROPIC_API_KEY`** to run the reasoning tier on the model SPEC 8
   specifies. Without it that tier degrades to `ROUTER_MODEL`, which is a much
   smaller model doing work the spec reserves for the strongest available one.

## Known spec deviations

- `docs/SPEC.md` section 8 names `@cf/qwen/qwen3-30b-a3b` as the router
  default. That id does not exist in the Workers AI catalog. The deployed
  value is `@cf/qwen/qwen3-30b-a3b-fp8`, the same model in the form Cloudflare
  actually serves. This is the one-line config change SPEC 8.2 anticipates.
