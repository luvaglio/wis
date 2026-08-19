# Architecture

Companion to `SPEC.md`. This document is the system-level view; `SPEC.md`
is the feature-level view. Where they overlap, `SPEC.md` is authoritative
on product behaviour, this file is authoritative on infrastructure.

## Stack, all Cloudflare-native

| Concern | Service |
|---|---|
| Compute / routing | Workers |
| Per-user live state, agent runtime | Durable Objects, via the Agents SDK |
| Structured data | D1 |
| Files, recordings, task artifacts | R2 |
| Semantic memory | Vectorize |
| Long-running, durable multi-step tasks | Workflows |
| Web browsing agent | Browser Run (Playwright / Stagehand) |
| Voice calls | Realtime Agents + PSTN provider |
| Outbound and inbound email | Email Service (Sending + Routing) |
| Auth code delivery | Email Service (Sending), no SMS provider |
| Model access | AI Gateway, fronting Workers AI and Anthropic |
| Short-lived tokens (OTP, pairing codes, card links) | KV |

## Request flow, a message from a user

1. WhatsApp/Telegram webhook, or inbound email, hits a Worker.
2. The Worker resolves the sender to a `user_id` and routes to that
   user's Durable Object instance.
3. The Durable Object's message handler assembles context (base system
   prompt, personality layer from D1, relevant memory from Vectorize,
   conversation history from its own storage, the current input) per
   `SPEC.md` section 9.
4. A call is made via AI Gateway to whichever model the relevant env
   var (`REASONING_MODEL` or `ROUTER_MODEL`) currently points at.
5. If the response requires a multi-step task (browsing, calling,
   emailing), the Durable Object acknowledges the user immediately and
   hands off to a Workflow, per `SPEC.md` section 10. It does not block
   the reply on task completion.
6. The Workflow executes its defined method chain, sending narration
   messages back through the same Worker/channel path at each defined
   transition point, and on final outcome.

## Why Durable Objects, one per user

- Natural per-user isolation: one instance only ever holds one user's
  state.
- Wakes on message, costs nothing while idle, no standing server per
  user.
- Built-in SQLite storage per instance, exactly matching the shape of
  "this user's live conversation and short-term memory."

## Why Workflows for tasks, not inline execution

- Survives restarts. A booking that fails halfway through resumes
  rather than silently dying.
- Forces the fallback-chain and notification structure described in
  `SPEC.md` section 10 to be explicit steps, rather than something a
  model has to remember to do correctly every time.

## Cost shape

The dominant cost is expected to be `REASONING_MODEL` tokens, by
design, since that's where product value is concentrated. Browser and
voice usage are metered per task, and both should stay well below LLM
spend at MVP scale. `ROUTER_MODEL` usage, run on Workers AI, is cheap
enough to use liberally for classification and narration work without
materially affecting the bill.
