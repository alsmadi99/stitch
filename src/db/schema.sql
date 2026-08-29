PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS reels (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  status         TEXT    NOT NULL DEFAULT 'building',
  clip_count     INTEGER NOT NULL DEFAULT 0,
  video_path     TEXT,
  thumbnail_path TEXT,
  youtube_id     TEXT,
  youtube_url    TEXT,
  title          TEXT,
  error          TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  published_at   TEXT
);

CREATE TABLE IF NOT EXISTS clips (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   TEXT    NOT NULL,
  channel_id   TEXT    NOT NULL,
  guild_id     TEXT,
  author_id    TEXT    NOT NULL,
  author_name  TEXT    NOT NULL,
  source_type  TEXT    NOT NULL,
  source_url   TEXT    NOT NULL,
  file_path    TEXT,
  content_hash TEXT,
  phash        TEXT,
  duration     REAL,
  width        INTEGER,
  height       INTEGER,
  has_audio    INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'pending',
  reel_id      INTEGER REFERENCES reels(id) ON DELETE SET NULL,
  note         TEXT,
  message_at   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (message_id, source_url)
);

CREATE INDEX IF NOT EXISTS idx_clips_status     ON clips(status);
CREATE INDEX IF NOT EXISTS idx_clips_hash       ON clips(content_hash);
CREATE INDEX IF NOT EXISTS idx_clips_reel       ON clips(reel_id);
CREATE INDEX IF NOT EXISTS idx_clips_message_at ON clips(message_at);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
