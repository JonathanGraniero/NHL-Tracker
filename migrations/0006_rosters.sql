-- NHL.com rosters, cached for a day. An r/hockey injury post only counts if
-- the player it names is on the team's roster.
CREATE TABLE rosters (
  team        TEXT    PRIMARY KEY,
  players     TEXT    NOT NULL,           -- JSON [{ "name": "Brock Faber", "position": "D" }]
  fetched_at  INTEGER NOT NULL            -- unix ms
);
