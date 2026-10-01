-- One row per channel per day the schedule was posted, so a retried or
-- repeated daily run never posts the same day twice.
CREATE TABLE daily_posts (
  day         TEXT    NOT NULL,           -- Eastern date, YYYY-MM-DD
  channel_id  TEXT    NOT NULL,
  message_id  TEXT    NOT NULL,
  posted_at   INTEGER NOT NULL,           -- unix ms
  PRIMARY KEY (day, channel_id)
);
