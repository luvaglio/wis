# Contributing

## Commits and pull requests

- Do not add "Co-authored-by" trailers referencing any AI tool.
- Do not mention Claude, Anthropic, or any AI assistant in commit
  messages, PR titles, or PR descriptions.
- Write commit messages and PR descriptions as you would for any other
  engineering work: what changed, why, and anything the reviewer needs
  to know. No mention of how the change was produced.

## Code review expectations

- Every task-execution flow (see `docs/SPEC.md`, "Task Execution & User
  Narration") must define its fallback chain and its user-facing
  notification points before merge. This is a standing architectural
  requirement, not a per-feature judgment call.
- Any new untrusted content source (a new inbound channel, a new tool
  that fetches external content) must go through the same
  labelled-content handling described in `docs/SPEC.md` before it can
  reach the reasoning model.
- UI for any new user-facing surface (cards, prompts, confirmations)
  must use the tokens in `design/tokens.json` / `design/tokens.css`
  rather than introducing new colours, type, or spacing values. See
  `docs/DESIGN_SYSTEM.md`.
