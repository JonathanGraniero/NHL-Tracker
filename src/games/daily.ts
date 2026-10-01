import { buildScheduleMessage } from "./format";
import { createMessage } from "../discord/api";
import { recordDailyPost, wasPostedOn } from "../db/daily";
import { getState, setState } from "../db/events";
import { ALL_TEAMS, channelsFollowing } from "../db/subscriptions";
import { NhlError, easternDate, fetchDay } from "../sources/nhl";
import type { Env } from "../env";

/** Must match the daily entry in infra/variables.tf (cron_schedules). 15:00 UTC = 11 am EDT / 10 am EST. */
export const DAILY_CRON = "0 15 * * *";
/**
 * If the daily run fails (NHL API down), the 2-minute cron keeps retrying
 * until this hour UTC (2 pm EDT / 1 pm EST), before the first afternoon games.
 */
const RETRY_UNTIL_HOUR_UTC = 18;
const START_HOUR_UTC = 15;

export function inDailyWindow(now: number): boolean {
  const hour = new Date(now).getUTCHours();
  return hour >= START_HOUR_UTC && hour < RETRY_UNTIL_HOUR_UTC;
}

/**
 * Posts today's games (Eastern date) to every channel subscribed to the
 * daily schedule: the whole slate for "All teams" channels, otherwise only
 * games involving the channel's teams. Channels with no games get nothing.
 * Safe to call repeatedly: each day and each channel is posted at most once.
 */
export async function runDailyGames(env: Env, now: number): Promise<void> {
  const day = easternDate(now);
  const doneKey = `daily_games:${day}`;
  if (await getState(env.DB, doneKey)) return;

  const channels = await channelsFollowing(env.DB, "games");
  if (channels.length > 0) {
    let games;
    try {
      ({ games } = await fetchDay(day));
    } catch (err) {
      if (err instanceof NhlError) {
        console.warn(`daily games: ${err.message}, retrying on the next run`);
        return;
      }
      throw err;
    }

    let posted = 0;
    for (const { channelId, teamCodes } of channels) {
      if (await wasPostedOn(env.DB, day, channelId)) continue;
      const allTeams = teamCodes.includes(ALL_TEAMS);
      const mine = allTeams ? games : games.filter((g) => teamCodes.includes(g.away) || teamCodes.includes(g.home));
      if (mine.length === 0) continue;

      const team = !allTeams && teamCodes.length === 1 ? teamCodes[0] : undefined;
      const sent = await createMessage(env.DISCORD_BOT_TOKEN, channelId, buildScheduleMessage({ date: day, games: mine, team }));
      if (sent.ok) {
        await recordDailyPost(env.DB, { day, channelId, messageId: sent.id }, now);
        posted++;
      } else {
        // Not retried: a missing permission won't fix itself in the next two minutes.
        console.error(`daily games: post to ${channelId} failed (${sent.status}): ${sent.error}`);
      }
    }
    console.log(`daily games: ${day}, ${games.length} games, posted to ${posted} of ${channels.length} channels`);
  }
  await setState(env.DB, doneKey, String(now));
}
