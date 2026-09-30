-- Reddit posts (or other source items) we've already looked at.
-- Layer 1 of dedupe: never process the same source item twice.
CREATE TABLE seen_items (
  source      TEXT    NOT NULL,           -- e.g. 'reddit'
  source_id   TEXT    NOT NULL,           -- e.g. Reddit post id 't3_abc123'
  first_seen  INTEGER NOT NULL,           -- unix ms
  PRIMARY KEY (source, source_id)
);

-- A confirmed transaction. One row per real-world move, however many
-- sources reported it. Layer 2 of dedupe: fingerprint is UNIQUE.
CREATE TABLE events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT    NOT NULL CHECK (type IN ('trade', 'waiver', 'signing')),
  teams        TEXT    NOT NULL,          -- JSON array of team codes, e.g. ["TOR","MTL"]
  players      TEXT    NOT NULL,          -- JSON array of player names
  headline     TEXT    NOT NULL,
  url          TEXT    NOT NULL,
  source       TEXT    NOT NULL,          -- who reported it, e.g. 'Friedman'
  fingerprint  TEXT    NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL           -- unix ms
);
CREATE INDEX idx_events_created_at ON events (created_at);

-- Which teams (and which transaction types) each channel follows.
-- team_code '*' means every team.
CREATE TABLE subscriptions (
  guild_id    TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  team_code   TEXT NOT NULL,
  types       TEXT NOT NULL DEFAULT 'trade,waiver,signing',
  PRIMARY KEY (channel_id, team_code)
);
CREATE INDEX idx_subscriptions_team ON subscriptions (team_code);

-- Every message we've sent. Layer 3 of dedupe: an event can reach a
-- channel at most once, even if a cron run is retried.
CREATE TABLE posted_messages (
  event_id    INTEGER NOT NULL REFERENCES events (id),
  channel_id  TEXT    NOT NULL,
  message_id  TEXT    NOT NULL,
  posted_at   INTEGER NOT NULL,
  PRIMARY KEY (event_id, channel_id)
);

-- Small key/value store for bot state (e.g. whether the first-run
-- backfill has happened, so we don't flood channels with old news).
CREATE TABLE bot_state (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
