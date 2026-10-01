import { isCountry, type Country } from "../types";

/** The channel's chosen TV country, or undefined to show both. */
export async function getTvCountry(db: D1Database, channelId: string): Promise<Country | undefined> {
  const value = await db
    .prepare("SELECT tv_country FROM channel_settings WHERE channel_id = ?")
    .bind(channelId)
    .first<string | null>("tv_country");
  return value && isCountry(value) ? value : undefined;
}

/** Saves the channel's TV country; undefined goes back to showing both. */
export async function setTvCountry(
  db: D1Database,
  setting: { guildId: string; channelId: string; country: Country | undefined },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO channel_settings (channel_id, guild_id, tv_country) VALUES (?, ?, ?)
       ON CONFLICT (channel_id) DO UPDATE SET tv_country = excluded.tv_country`,
    )
    .bind(setting.channelId, setting.guildId, setting.country ?? null)
    .run();
}
