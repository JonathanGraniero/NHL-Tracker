/** Whether the schedule for `day` already went to `channelId`. */
export async function wasPostedOn(db: D1Database, day: string, channelId: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM daily_posts WHERE day = ? AND channel_id = ?").bind(day, channelId).first()) !== null;
}

export async function recordDailyPost(
  db: D1Database,
  post: { day: string; channelId: string; messageId: string },
  now: number,
): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO daily_posts (day, channel_id, message_id, posted_at) VALUES (?, ?, ?, ?)")
    .bind(post.day, post.channelId, post.messageId, now)
    .run();
}
