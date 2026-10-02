-- Injury tracking. Every source (ESPN now, r/hockey later) attaches to one
-- *episode* per player injury, so the same injury is posted once however many
-- places report it. The three dedupe layers mirror the news pipeline:
--   source item  -> injury_snapshot (ESPN) / seen_items (Reddit)
--   episode      -> injury_episodes (at most one open per player)
--   channel      -> injury_posts

-- ESPN's injury list as of the last check, to diff the next one against.
CREATE TABLE injury_snapshot (
  team         TEXT    NOT NULL,
  player_key   TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  injury       TEXT,
  return_date  TEXT,
  updated_at   INTEGER NOT NULL,          -- ESPN's last update, unix ms
  -- Consecutive checks this player was missing from the list. Two in a row
  -- means he's back; one could just be a glitchy response.
  missing      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (team, player_key)
);

-- One player's injury, from the first report until he's back.
CREATE TABLE injury_episodes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  team            TEXT    NOT NULL,
  player_key      TEXT    NOT NULL,
  player          TEXT    NOT NULL,
  position        TEXT,
  status          TEXT    NOT NULL CHECK (status IN ('day-to-day', 'out', 'ir', 'suspended')),
  injury          TEXT,
  return_date     TEXT,
  note            TEXT,
  first_source    TEXT    NOT NULL,       -- 'espn' or 'reddit'
  reporter        TEXT,                   -- who broke it, e.g. 'Michael Russo'
  thread_url      TEXT,                   -- r/hockey thread, if any
  player_url      TEXT,                   -- ESPN player page
  espn_confirmed  INTEGER NOT NULL DEFAULT 0,
  opened_at       INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  closed_at       INTEGER
);
CREATE UNIQUE INDEX idx_injury_episodes_open ON injury_episodes (team, player_key) WHERE closed_at IS NULL;

-- Changes worth a Discord message. 'reported' is the first post about an
-- episode; 'update' (got worse) and 'returned' are posted as replies to it.
CREATE TABLE injury_updates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id  INTEGER NOT NULL REFERENCES injury_episodes (id),
  kind        TEXT    NOT NULL CHECK (kind IN ('reported', 'update', 'returned')),
  from_status TEXT,
  to_status   TEXT,
  created_at  INTEGER NOT NULL,
  -- Set once every subscribed channel has been tried, so a run that died
  -- halfway can finish posting on the next one.
  done        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_injury_updates_pending ON injury_updates (done, created_at);

-- Every injury message sent, so an update reaches a channel once, and so
-- later changes can edit the original message or reply to it.
CREATE TABLE injury_posts (
  update_id   INTEGER NOT NULL REFERENCES injury_updates (id),
  channel_id  TEXT    NOT NULL,
  message_id  TEXT    NOT NULL,
  posted_at   INTEGER NOT NULL,
  PRIMARY KEY (update_id, channel_id)
);
