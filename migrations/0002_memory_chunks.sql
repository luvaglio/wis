-- Track which Vectorize vectors belong to which user.
--
-- Vectorize has no delete-by-filter, so "delete everything you hold on me"
-- (site/values: "You can download or delete it at any time") needs the vector
-- ids on our side. Without this table the semantic memory would survive an
-- account deletion, which would make that promise untrue.

CREATE TABLE memory_chunks (
  vector_id  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'onboarding',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_memory_chunks_user ON memory_chunks (user_id);
