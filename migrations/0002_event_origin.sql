-- The source item that first reported each event, so a cron run that died
-- halfway through posting can find its event again and finish the job, and
-- the original link (tweet or nhl.com article) to show in the embed.
ALTER TABLE events ADD COLUMN item_id TEXT;
ALTER TABLE events ADD COLUMN link TEXT;
ALTER TABLE events ADD COLUMN published_at INTEGER;
CREATE INDEX idx_events_item_id ON events (item_id);
