import { readFileSync } from "node:fs";
import { join } from "node:path";

// The real NHL schedule for the week of 2026-10-07, trimmed to
// the fields the bot reads.
export const WEEK = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/nhl-schedule-2026-10-07.json"), "utf8")) as {
  nextStartDate: string;
  gameWeek: { date: string; games: { awayTeam: { abbrev: string }; homeTeam: { abbrev: string } }[] }[];
};

/**
 * What /v1/schedule/{date} returns for the fixture: the week starting at
 * {date}. Dates outside the fixture get an empty off-season week.
 */
export function scheduleResponse(date: string): unknown {
  const days = WEEK.gameWeek.filter((d) => d.date >= date);
  if (days.length === 0 || days[0]!.date !== date) {
    return { nextStartDate: "2026-09-14", gameWeek: [{ date, numberOfGames: 0, games: [] }] };
  }
  return { ...WEEK, gameWeek: days };
}
