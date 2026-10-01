import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NhlScheduleResponse } from "../../src/sources/nhl";

// The real NHL schedule for the week of 2026-10-07, trimmed to
// the fields the bot reads.
export const WEEK = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/nhl-schedule-2026-10-07.json"), "utf8"),
) as Required<NhlScheduleResponse>;

/**
 * What /v1/schedule/{date} returns for the fixture: the week starting at
 * {date}. Dates outside the fixture get an empty off-season week.
 */
export function scheduleResponse(date: string): NhlScheduleResponse {
  const days = WEEK.gameWeek.filter((d) => d.date >= date);
  if (days[0]?.date !== date) {
    return { nextStartDate: "2026-09-14", gameWeek: [{ date, games: [] }] };
  }
  return { ...WEEK, gameWeek: days };
}
