-- Per-channel preferences that aren't tied to a team.
CREATE TABLE channel_settings (
  channel_id  TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  -- Only show this country's TV channels in game posts. NULL = both.
  tv_country  TEXT CHECK (tv_country IN ('US', 'CA'))
);
