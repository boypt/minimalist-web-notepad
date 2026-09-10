-- Minimalist Web Notepad — initial D1 schema.
--
-- Note bodies are zstd-compressed and stored as a BLOB in `content`.
-- `content_encoding` records the codec so the format can evolve without a
-- migration (currently 'zstd'; 'gzip' and 'identity' are also understood).
--
-- Password columns are reserved for the planned password-protected view.
-- They are written by future code only; the current Worker stores
-- is_protected = 0 and never enforces a password.
--
-- Timestamps are Unix epoch milliseconds (UTC):
--   created_at / updated_at : lifecycle bookkeeping
--   expires_at              : NULL = never expires; Cron deletes rows in the past
--   last_accessed_at        : reserved for future sliding-expiry / stats

CREATE TABLE IF NOT EXISTS notes (
    id               TEXT PRIMARY KEY,
    content          BLOB,
    content_encoding TEXT    NOT NULL DEFAULT 'zstd',
    size_raw         INTEGER NOT NULL DEFAULT 0,
    size_stored      INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    expires_at       INTEGER,
    last_accessed_at INTEGER,
    view_count       INTEGER NOT NULL DEFAULT 0,
    is_protected     INTEGER NOT NULL DEFAULT 0,
    password_hash    TEXT,
    password_salt    TEXT,
    password_algo    TEXT
);

-- Garbage collection scans by expiry.
CREATE INDEX IF NOT EXISTS idx_notes_expires_at ON notes (expires_at);
