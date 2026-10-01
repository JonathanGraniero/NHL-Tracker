import { describe, expect, it } from "vitest";
import { espnPlus } from "../src/games/espn";
import { parseWeek } from "../src/sources/nhl";
import { WEEK } from "./helpers/nhl";

const week = parseWeek(WEEK);
const game = (date: string, away: string, home: string) =>
  week.days.find((d) => d.date === date)!.games.find((g) => g.away === away && g.home === home)!;

// Real games from the NHL.com fixture, one per kind of US listing.
describe("espnPlus", () => {
  it.each([
    ["only local channels", "2026-10-08", "UTA", "BOS", { kind: "out-of-market", blackedOut: ["UTA", "BOS"] }],
    ["NHL Network (not exclusive)", "2026-10-10", "PHI", "BOS", { kind: "out-of-market", blackedOut: ["PHI", "BOS"] }],
    ["a Canadian team", "2026-10-08", "NSH", "MTL", { kind: "out-of-market", blackedOut: ["NSH"] }],
    ["TNT · HBO Max", "2026-10-07", "PIT", "WSH", { kind: "national" }],
    ["ESPN", "2026-10-13", "NJD", "DET", { kind: "national" }],
    ["ESPN+ · Hulu · Disney+", "2026-10-08", "SJS", "STL", { kind: "national" }],
    ["ESPN plus a local channel", "2026-10-13", "BOS", "SJS", { kind: "unknown" }],
  ])("%s → %j", (_label, date, away, home, expected) => {
    expect(espnPlus(game(date, away, home))).toEqual(expected);
  });

  it("covers most of a normal week", () => {
    const all = week.days.flatMap((d) => d.games);
    const outOfMarket = all.filter((g) => espnPlus(g).kind === "out-of-market");
    expect(all).toHaveLength(53);
    expect(outOfMarket).toHaveLength(48);
  });
});
