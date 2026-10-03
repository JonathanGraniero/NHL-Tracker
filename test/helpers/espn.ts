import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EspnInjuriesResponse, EspnInjury } from "../../src/sources/espn-injuries";

// ESPN's real league-wide injury list from 2026-10-02 (111 entries), trimmed
// to the fields the bot reads.
export const ESPN_FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/espn-injuries-2026-10-02.json"), "utf8"),
) as Required<EspnInjuriesResponse>;

/** An ESPN entry with sensible defaults, for building scenarios. */
export function espnEntry(
  over: {
    player: string;
    team: string;
    status?: "DD" | "O" | "IR" | "SUSP";
    body?: string;
    returnDate?: string;
    note?: string;
    date?: string;
    position?: string;
    side?: string;
    /** ESPN's status code; defaults to `status` (ESPN files some suspensions as IR). */
    code?: "DD" | "O" | "IR" | "SUSP";
  },
): EspnInjury {
  const status = over.status ?? "IR";
  return {
    status: { DD: "Day-To-Day", O: "Out", IR: "Injured Reserve", SUSP: "Suspension" }[status],
    date: over.date ?? "2026-10-02T15:00Z",
    shortComment: over.note ?? `${over.player} (${(over.body ?? "lower body").toLowerCase()}) update, per a beat writer.`,
    type: { abbreviation: over.code ?? status },
    details: {
      type: over.body ?? (status === "SUSP" ? "Suspension" : "Lower Body"),
      side: over.side ?? null,
      returnDate: over.returnDate ?? "2026-10-20",
    },
    athlete: {
      displayName: over.player,
      position: { abbreviation: over.position ?? "C" },
      team: { abbreviation: over.team },
      links: [{ href: `https://www.espn.com/nhl/player/_/id/${over.player.length}` }],
    },
  };
}

/**
 * A league-wide response: `entries` plus 24 steady background injuries, so
 * the "most of the league vanished" glitch check behaves like production.
 */
export function espnResponse(entries: EspnInjury[]): EspnInjuriesResponse {
  const background = [...Array(24).keys()].map((i) => espnEntry({ player: `Depth Player${String.fromCharCode(65 + i)}`, team: "SEA" }));
  return { injuries: [{ displayName: "All", injuries: [...background, ...entries] }] };
}
