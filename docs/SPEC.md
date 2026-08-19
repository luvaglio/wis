# Wis.ai, MVP Specification

## 1. Product summary

Wis.ai is a personal assistant, hired the way a person would hire a real
assistant. It works over messaging channels the user already has
(WhatsApp and Telegram at launch), has its own computer with internet
access, a voice, a phone number, and an email address, and it acts on
the user's behalf within the permissions the user has given it.

Three things matter more than interface: intelligence, memory, and
personality. The interface is deliberately plain, the product is
everything behind it.

## 2. Users and accounts

### 2.1 Account identity

- **Authentication is email-based**, not phone-based. Email + one-time
  code is the login mechanism.
- The **mobile number is still captured**, but as an attached contact
  field, not an auth factor. It is verified implicitly later, by the
  act of linking WhatsApp or Telegram (see 4.3), rather than by a
  separate OTP step.
- At signup we also capture: **full name**, **country**, and **address
  details**. These are account fields, not part of the personality
  onboarding conversation.

### 2.2 Why email, not SMS

Email auth removes the regulated-telecom surface entirely (no carrier
registration, no per-country SMS pricing variance, no TCPA consent
language for the login flow itself). It also lets us stay on one
provider, Cloudflare Email Service, for both sending the OTP and,
later, running each assistant's own inbox. See section 6.

### 2.3 Data model (accounts)

```
users
  id                uuid, primary key
  email             text, unique, not null
  name              text
  country            text
  address           text
  mobile_number     text, nullable until channel-linked
  mobile_verified   boolean, default false
  created_at        timestamp
  last_seen_at      timestamp
  onboarded         boolean, default false
```

`mobile_verified` flips to true the moment a channel link (4.3)
succeeds against that number, this is the implicit verification, no
separate step is spec'd for it.

## 3. Onboarding ("let's grab a coffee")

A short conversational flow, not a form, run over the same messaging
surface the product otherwise uses. Steps, in order:

1. **Assistant name.** Free text. Defaults to "Wis" if skipped.
2. **How the user wants to be addressed.** Free text (first name,
   nickname, formal).
3. **Personality.** A fixed set of presets, not open text, so it maps
   cleanly to a system-prompt variable:
   - **British butler** (default), dry, precise, addresses the user as
     "Sir" or "Madam" unless the user has specified an alternative form
     of address in step 2 or later.
   - Warm
   - No-nonsense
   - Formal
   - "Other", a free-text escape hatch that still gets normalised into
     one of the above at storage time, or stored as a labelled custom
     variant if it clearly doesn't fit any preset.
4. **Language.** Auto-suggested from account country/locale, user can
   override.
5. **Proactivity.** A slider (1 to 5, "only when asked" to "checks in
   and anticipates things for you"), with a live usage gauge beneath
   it showing a concrete estimate, e.g. "roughly 20 messages a month",
   not an abstract token count. This setting is revisitable later from
   the assistant's own settings.
6. **Free-form context.** Either typed, or captured via a hold-to-record
   button. Recordings are transcribed and the transcript is what gets
   stored and embedded; the audio itself is retained in R2 for the
   user's own reference and deletion, but is never replayed back into
   the assistant's reasoning.

### 3.1 Output of onboarding

- A `preferences` row in D1 (assistant name, address-as, personality
  preset, language, proactivity level).
- One or more embedded chunks in Vectorize from the free-text or
  transcribed context, for later semantic recall.
- `users.onboarded` flips to true.

## 4. Channel connection

### 4.1 Supported channels at launch

WhatsApp and Telegram. Both can be linked to the same account
simultaneously.

### 4.2 Multi-channel rule

A user may have both channels linked at once. Only **one channel is
"active"** for proactive, assistant-initiated outbound messages at any
time, to avoid double-notifying. Replies within an existing thread on
either channel always work regardless of which is "active." The active
channel is switchable from settings.

### 4.3 Linking flow

Standard "click to chat" pattern, no custom bridging:

1. User taps "Connect WhatsApp" (or Telegram) in the web app.
2. Backend generates a short-lived, single-use pairing token.
3. Rendered as a QR code and a deep link.
4. Scanning opens WhatsApp/Telegram pre-filled with a start message
   containing the token.
5. The bot validates the token and binds that channel identity to
   `user_id`.
6. If the channel identity's phone number matches `users.mobile_number`,
   `mobile_verified` flips true. If it doesn't match (e.g. Telegram
   account not tied to the same number), the assistant asks once
   whether to update the stored mobile number.

## 5. Data storage

No literal per-user folder tree. The "ring-fenced" feel is achieved
with real infrastructure, scoped consistently by `user_id`:

| Data | Store | Notes |
|---|---|---|
| Accounts, preferences, tasks, connections | **D1** | Structured, queryable |
| Files (recordings, transcripts, task artifacts) | **R2** | Path-scoped: `users/{uuid}/...` |
| Live conversation state, short-term memory | **Durable Object**, one per user | Built-in SQLite storage via Agents SDK |
| Semantic memory (embedded preferences, context) | **Vectorize** | Queried fresh per relevant turn, never bulk-loaded into every prompt |

## 6. Assistant email address

### 6.1 Domains

- **`verify@wis.ai`**, sends OTP/auth email only.
- **`{handle}@me.wis.ai`**, every assistant's own address. Kept on a
  separate subdomain from the primary sending domain so that a spam
  complaint against one user's assistant inbox can never damage the
  deliverability of account/auth email.

### 6.2 Handle generation

- **Default format:** assistant name, lowercased, plus a short random
  suffix, e.g. `aria.4f2k@me.wis.ai`. Kept short, name plus a compact
  suffix, not a long hash.
- **Availability check offered at onboarding.** If the user wants to
  choose or edit the handle, we check availability live and reject
  collisions; otherwise the default generated handle is used
  automatically with no user action required.

### 6.3 Sending and receiving

Built on **Cloudflare Email Service** (Email Sending + Email Routing),
no external ESP:

- **Inbound:** one catch-all Email Routing rule on `me.wis.ai` forwards
  all mail to a single Worker, which reads the `To` header, resolves
  the handle to a `user_id`, and hands the message to that user's
  Durable Object.
- **Outbound:** sent via the `env.EMAIL.send()` binding, `From` set to
  that user's actual handle, so replies genuinely come from the
  assistant's own address.

### 6.4 Inbound email is untrusted content

Email the assistant receives is handled under the same rules as any
other untrusted external input, see section 9. It is never treated as
an instruction source.

## 7. Secure user cards

### 7.1 Trigger model

Assistant-triggered, single-use, opt-in per request. Nothing is
pre-collected speculatively; there is no standing "wallet" the
assistant pre-fills from at will in v1.

### 7.2 What they cover

- **Payment card**, tokenised via Stripe. Wis.ai infrastructure never
  touches the PAN.
- **Passwords/logins**, stored in a dedicated secrets vault, never in
  the application database. The assistant holds a reference, not the
  raw value.
- **Third-party connectors** (Gmail, etc.), standard OAuth, only the
  encrypted refresh token is stored.

### 7.3 Presentation

- Every card link is **short**, generated as a short-path token
  (`wis.ai/c/{shortcode}`), not a long signed URL, so it's clean to
  read and tap on mobile inside a chat thread.
- Every card is single-use and time-limited.
- Every card states plainly why the assistant is asking for it.
- **Visually, cards are not a separate design system.** They reuse the
  exact type, colour, spacing, and motion tokens defined in
  `docs/DESIGN_SYSTEM.md` and `design/tokens.json`. A payment
  confirmation card and the `/start` phone entry screen should look
  like they came from the same hand, because they did.

## 8. Model configuration

Two model tiers, each a single environment variable, never hardcoded
in application code:

| Env var | Purpose | Default |
|---|---|---|
| `REASONING_MODEL` | The assistant's actual conversation, planning, and task decisions, anything acting on the user's behalf | `claude-sonnet-5` (via AI Gateway) |
| `ROUTER_MODEL` | Cheap/fast work: intent routing, classification, the injection-screening pass on untrusted content, phrasing known task-status updates | `@cf/qwen/qwen3-30b-a3b` (Workers AI, via AI Gateway) |

### 8.1 Why two tiers, not one

Routing, classification, and status narration don't need frontier
reasoning and are well suited to an efficient open-weight model
running directly on Cloudflare's network at low cost. Decisions that
commit the user to something real, bookings, purchases, messages sent
on their behalf, default to the strongest available model.

### 8.2 On "always latest"

Cloudflare does not currently expose a single catalog-wide "always the
newest model" alias. What we get instead, and what the env-var design
is for, is a one-line change to move either tier to a newer model as
better options become available, no code change, no redeploy of logic,
just a config update. Model choice should be revisited periodically,
not treated as fixed at launch.

### 8.3 Routing

All model calls, regardless of tier or provider, go through
**AI Gateway**, not directly to a provider endpoint. This gives
logging, cost tracking, and fallback chains for free, independent of
which model sits behind either env var.

## 9. Agent runtime and prompt architecture

### 9.1 Runtime

**Cloudflare Agents SDK on Durable Objects**, one Durable Object
instance per user. The SDK provides state persistence, message
routing, tool-call orchestration, and hooks for scheduling and
Workflows. It does **not** provide prompt-safety or context-labelling,
that is application logic built inside the DO, described below.

### 9.2 Where each layer of context lives

| Layer | Storage | Assembled |
|---|---|---|
| Base system prompt (product-wide behaviour, injection-handling rules) | Versioned constant in application code | Static across all users |
| Personality layer (name, address-as, personality preset, language) | D1, keyed by `user_id` | Generated once at onboarding, re-read every turn |
| Semantic memory | Vectorize | Queried fresh per relevant turn |
| Conversation history | Durable Object's own SQLite storage | Local to that instance |
| Current input / untrusted external content | Assembled at call time | Labelled and wrapped, never merged into system prompt or history as if user-authored |

### 9.3 Where injection happens

All four layers are stitched into the model call **inside the Durable
Object's message handler, at call time, every turn.** This is the one
place in the codebase that owns "what does the model actually see this
turn," and it is the natural enforcement point for the untrusted
content rules below.

### 9.4 Untrusted content handling

Applies to any external input the assistant did not directly receive
as a message typed by its own user, inbound email, fetched web pages,
tool output from browsing:

1. **Ingestion layer** (the Worker or tool call that first receives the
   content) separates structural metadata (sender, source, headers)
   from body content, and never lets raw external content decide
   formatting or delimiters.
2. **Context construction** wraps external content as clearly labelled
   reference material, with an explicit instruction that content
   inside the wrapper is data to act on, never a command to follow.
   The user's own instructions live in a separate, privileged part of
   the context that external content can never append to or override.
3. **Tool-permission boundary.** Even if reasoning is influenced by
   injected content, consequential actions (sending, purchasing,
   forwarding, clicking through, initiating any secure-card flow)
   require the standard confirmation step, especially when the
   triggering content originated from an external source rather than
   the user directly.
4. **Detection.** A lightweight `ROUTER_MODEL` pass flags suspected
   injection attempts on inbound external content as telemetry, not as
   the sole defence.

This is a standing requirement for any current or future untrusted
content source, not something specific to email.

## 10. Task execution and user narration

Applies to every agentic task, not a single example. Any task that
leaves the conversation, browsing, calling, emailing, waiting on a
third party, runs as a **Workflow**, not inline in the Durable Object's
message handler.

### 10.1 Standard shape every task Workflow must define

1. An ordered list of methods to attempt, cheapest/fastest to most
   expensive/slowest for that task type (e.g. direct API, browser
   agent, voice call).
2. A user-facing notification at every transition between methods,
   sent **before** the next method is attempted.
3. A final outcome message on success, partial success (needs user
   input), or full failure. Failure always includes next options,
   never a dead end.

### 10.2 Division of responsibility

- **Method sequence and transition logic**, deterministic Workflow
  steps with their own failure handling. Not left to model judgement.
- **Notification wording**, generated per step by `ROUTER_MODEL` (or
  `REASONING_MODEL` where more nuance is warranted), constrained to
  "phrase this known event in the user's configured personality." The
  model decides tone, never whether or when to notify.
- **Escalation thresholds** (retry counts, what counts as
  "unavailable" vs. "temporary error"), externalised as task-type
  config, not hardcoded per task, so they're tunable without touching
  Workflow structure.

### 10.3 This is v1, expected to be tuned

The exact fallback chain per task type is a first-pass assumption. As
real usage shows which fallbacks help versus waste time or cost, method
sequences and thresholds should be adjustable as data or config,
ideally without a redeploy. Spec the config as externalised (D1, or a
simple config table) from the outset, even with a single task type at
launch.

## 11. Feature scope discipline

Net third-party surface for v1: an SMS-free, self-rolled auth flow
(section 2), Cloudflare Email Service (section 6), Stripe and a
secrets vault (section 7), WhatsApp and Telegram platform APIs
(section 4), and AI Gateway sitting in front of Workers AI and
Anthropic (section 8). Everything else, auth logic, storage, memory,
browser automation, voice, sits on Cloudflare primitives already
covered elsewhere in this document. New third-party dependencies
should be treated as an exception requiring justification, not a
default.

## 12. Open items carried forward

None blocking v1 build start. Items to revisit once real usage exists:
task-type fallback chain tuning (10.3), whether additional personality
presets are wanted beyond the four plus custom, and whether proactivity
level should gain a hard tier-based cap once pricing plans exist.
