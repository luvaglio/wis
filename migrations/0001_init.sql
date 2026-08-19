-- Wis.ai initial schema.
-- See docs/SPEC.md sections 2.3, 3.1, 4, 5, 7 and 10.3.
-- Everything user-scoped is keyed by user_id; there is no per-user folder
-- tree, the ring-fencing is enforced by consistent scoping (SPEC 5).

-- ---------------------------------------------------------------------------
-- Accounts (SPEC 2.3)
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT,
  country         TEXT,
  address         TEXT,
  mobile_number   TEXT,
  mobile_verified INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at    INTEGER,
  onboarded       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_users_mobile ON users (mobile_number);

-- ---------------------------------------------------------------------------
-- Onboarding output (SPEC 3.1)
-- The personality layer. Re-read every turn by the Durable Object when it
-- assembles context (SPEC 9.2).
-- ---------------------------------------------------------------------------
CREATE TABLE preferences (
  user_id           TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  assistant_name    TEXT NOT NULL DEFAULT 'Wis',
  address_as        TEXT,
  personality       TEXT NOT NULL DEFAULT 'butler',
  personality_note  TEXT,
  language          TEXT NOT NULL DEFAULT 'en',
  proactivity       INTEGER NOT NULL DEFAULT 3,
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (proactivity BETWEEN 1 AND 5),
  CHECK (personality IN ('butler', 'warm', 'no-nonsense', 'formal', 'custom'))
);

-- ---------------------------------------------------------------------------
-- Assistant email handles (SPEC 6.2)
-- One row per user. handle is unique across the whole me.wis.ai subdomain,
-- which is what makes the live availability check possible.
-- ---------------------------------------------------------------------------
CREATE TABLE assistant_handles (
  handle     TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ---------------------------------------------------------------------------
-- Channel connections (SPEC 4)
-- A user may link both channels. Exactly one may be active for proactive
-- outbound at a time; that is enforced in application logic and by the
-- partial unique index below.
-- ---------------------------------------------------------------------------
CREATE TABLE connections (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel             TEXT NOT NULL,
  channel_user_id     TEXT NOT NULL,
  channel_phone       TEXT,
  is_active_outbound  INTEGER NOT NULL DEFAULT 0,
  linked_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (channel IN ('whatsapp', 'telegram')),
  UNIQUE (channel, channel_user_id),
  UNIQUE (user_id, channel)
);

-- Only one active outbound channel per user (SPEC 4.2).
CREATE UNIQUE INDEX idx_one_active_outbound
  ON connections (user_id)
  WHERE is_active_outbound = 1;

-- ---------------------------------------------------------------------------
-- Sessions for the web app.
-- Token is stored as a SHA-256 hash, never in plaintext.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions (user_id);

-- ---------------------------------------------------------------------------
-- Tasks (SPEC 10)
-- One row per agentic task. The Workflow instance id lets the Durable Object
-- query, narrate and terminate a running task.
-- ---------------------------------------------------------------------------
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  task_type     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  request       TEXT NOT NULL,
  method_index  INTEGER NOT NULL DEFAULT 0,
  outcome       TEXT,
  workflow_id   TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (status IN ('pending', 'running', 'needs_input', 'succeeded', 'partial', 'failed'))
);

CREATE INDEX idx_tasks_user ON tasks (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Task-type configuration (SPEC 10.3)
-- Fallback chains and escalation thresholds live here as data, not as
-- hardcoded Workflow structure, so they are tunable without a redeploy.
-- ---------------------------------------------------------------------------
CREATE TABLE task_type_config (
  task_type        TEXT PRIMARY KEY,
  methods          TEXT NOT NULL,
  max_attempts     INTEGER NOT NULL DEFAULT 2,
  attempt_timeout  INTEGER NOT NULL DEFAULT 60,
  notify_on_switch INTEGER NOT NULL DEFAULT 1,
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Launch config. Ordered cheapest/fastest first, per SPEC 10.1.
INSERT INTO task_type_config (task_type, methods, max_attempts, attempt_timeout) VALUES
  ('reservation', '["api","browser","voice"]', 2, 90),
  ('research',    '["api","browser"]',         2, 120),
  ('outreach',    '["email","voice"]',         2, 90),
  ('generic',     '["api","browser"]',         2, 90);

-- ---------------------------------------------------------------------------
-- Secure user cards (SPEC 7)
-- The row holds a reference and a reason, never a secret value. Card
-- shortcodes live in KV with a TTL; this table is the audit record.
-- ---------------------------------------------------------------------------
CREATE TABLE cards (
  shortcode   TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  card_type   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  task_id     TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  reference   TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  CHECK (card_type IN ('payment', 'credential', 'connector')),
  CHECK (status IN ('pending', 'completed', 'expired', 'cancelled'))
);

CREATE INDEX idx_cards_user ON cards (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Injection-screening telemetry (SPEC 9.4 item 4)
-- The router-model screening pass records suspicion here. This is telemetry,
-- explicitly not the sole defence.
-- ---------------------------------------------------------------------------
CREATE TABLE injection_flags (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users (id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  verdict     TEXT NOT NULL,
  detail      TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_injection_created ON injection_flags (created_at DESC);
