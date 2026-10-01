import { describe, expect, it } from "vitest";
import { buildScheduleMessage, gameBlock } from "../src/games/format";
import { networkLabel } from "../src/games/networks";
import { easternDate, formatDay, parseWeek, type Broadcast, type Game } from "../src/sources/nhl";
import { WEEK } from "./helpers/nhl";

const week = parseWeek(WEEK);
const day = (date: string) => week.days.find((d) => d.date === date)!.games;
const game = (date: string, away: string, home: string) => day(date).find((g) => g.away === away && g.home === home)!;

describe("parseWeek", () => {
  it("reads every day and game", () => {
    expect(week.days.map((d) => d.games.length)).toEqual([3, 10, 4, 14, 3, 3, 16]);
    expect(week.nextStartDate).toBe("2026-10-14");
  });

  it("lists late western games under the Eastern date", () => {
    const vegas = game("2026-10-10", "LAK", "VGK");
    expect(new Date(vegas.startTime).toISOString()).toBe("2026-10-11T02:00:00.000Z");
    expect(vegas.day).toBe("2026-10-10");
  });

  it("sorts games by start time and trims network names", () => {
    const games = day("2026-10-10");
    expect(games.map((g) => g.startTime)).toEqual([...games.map((g) => g.startTime)].sort((a, b) => a - b));
    expect(game("2026-10-10", "LAK", "VGK").broadcasts.map((b) => b.network)).toContain("ABTV");
  });

  it("links each game to its Game Center page", () => {
    expect(game("2026-10-07", "PIT", "WSH").url).toBe("https://www.nhl.com/gamecenter/pit-vs-wsh/2026/10/07/2026020053");
  });
});

describe("easternDate", () => {
  it.each([
    ["2026-10-10T15:00:00Z", 0, "2026-10-10"],
    ["2026-10-11T02:30:00Z", 0, "2026-10-10"], // 10:30 pm EDT
    ["2026-10-11T04:30:00Z", 0, "2026-10-11"], // 12:30 am EDT
    ["2026-12-01T04:30:00Z", 0, "2026-11-30"], // 11:30 pm EST
    ["2026-10-10T15:00:00Z", 1, "2026-10-11"],
    ["2026-10-31T15:00:00Z", 1, "2026-11-01"],
    ["2026-03-01T15:00:00Z", -1, "2026-02-28"],
  ])("%s %+d days → %s", (time, add, expected) => {
    expect(easternDate(Date.parse(time), add)).toBe(expected);
  });

  it("formats a day", () => {
    expect(formatDay("2026-10-10")).toBe("Saturday, Oct 10");
  });
});

describe("gameBlock", () => {
  it("puts the time and matchup on one line, then each country's channels under its flag", () => {
    const g = game("2026-10-10", "PHI", "BOS");
    expect(gameBlock(g)).toBe(
      [
        `<t:${Date.parse("2026-10-10T17:00:00Z") / 1000}:t> · **[PHI @ BOS](${g.url})**`,
        "🇺🇸 NHL Network · NBC Sports Philadelphia (PHI) · NESN (BOS)",
        "🇨🇦 Sportsnet · TVA Sports (French)",
      ].join("\n"),
    );
  });

  it("never lists a Canadian channel on the US line, or the other way round", () => {
    const g = game("2026-10-10", "PHI", "BOS");
    const [, us, ca] = gameBlock(g).split("\n");
    expect(us).not.toMatch(/Sportsnet|TVA|TSN|RDS/);
    expect(ca).not.toMatch(/NHL Network|NESN|NBC/);
  });

  it("shows one country when asked", () => {
    const g = game("2026-10-10", "PHI", "BOS");
    expect(gameBlock(g, { country: "US" })).not.toContain("🇨🇦");
    expect(gameBlock(g, { country: "US" })).not.toContain("TVA");
    expect(gameBlock(g, { country: "CA" }).split("\n").slice(1)).toEqual(["🇨🇦 Sportsnet · TVA Sports (French)"]);
  });

  it("names a channel once when it carries both teams", () => {
    const g = game("2026-10-13", "VGK", "NSH");
    expect(gameBlock(g).split("\n")[1]).toBe("🇺🇸 Scripps Sports (VGK, NSH)");
  });

  it("can leave out team channels to save space", () => {
    const g = game("2026-10-10", "PHI", "BOS");
    expect(gameBlock(g, { nationalOnly: true }).split("\n").slice(1)).toEqual(["🇺🇸 NHL Network", "🇨🇦 Sportsnet · TVA Sports (French)"]);
  });

  it("shows scores, live games and postponements instead of a start time", () => {
    const g = game("2026-10-07", "PIT", "WSH");
    expect(gameBlock({ ...g, state: "FINAL", awayScore: 3, homeScore: 2 })).toMatch(/^Final 3–2 · \*\*\[PIT @ WSH\]/);
    expect(gameBlock({ ...g, state: "LIVE", awayScore: 1, homeScore: 0 })).toMatch(/^🔴 Live 1–0 · /);
    expect(gameBlock({ ...g, scheduleState: "PPD" })).toBe(`Postponed · **[PIT @ WSH](${g.url})**`);
  });

  it("marks preseason games", () => {
    expect(gameBlock({ ...game("2026-10-07", "PIT", "WSH"), gameType: 1 })).toContain("(preseason)");
  });
});

describe("networkLabel", () => {
  it.each([
    ["TVAS", [], "TVA Sports (French)"],
    ["RDS", ["MTL"], "RDS (MTL, French)"],
    ["NESN", ["BOS"], "NESN (BOS)"],
    ["SNP", [], "Sportsnet Pacific"],
    ["MSG-B", ["BUF"], "MSG Buffalo (BUF)"],
    ["HBO MAX", [], "HBO Max"],
    ["CBJNHL", ["CBJ"], "CBJNHL (CBJ)"], // unknown codes are shown as NHL.com sends them
  ])("%s %j → %s", (code, teams, label) => {
    expect(networkLabel(code, teams)).toBe(label);
  });
});

describe("buildScheduleMessage", () => {
  it("fits the busiest night in one embed", () => {
    const games = day("2026-10-13");
    expect(games).toHaveLength(16);
    const embed = buildScheduleMessage({ date: "2026-10-13", games }).embeds![0]!;
    expect(embed.title).toBe("🏒 NHL games · Tuesday, Oct 13");
    expect(embed.url).toBe("https://www.nhl.com/schedule/2026-10-13");
    expect(embed.description!.split("\n\n")).toHaveLength(16);
    expect(embed.description!.length).toBeLessThanOrEqual(4096);
  });

  it("drops team channels rather than overflowing", () => {
    const busy: Game[] = Array.from({ length: 16 }, () => ({
      ...game("2026-10-10", "CBJ", "STL"),
      broadcasts: [...Array(30).keys()].map((i): Broadcast => ({ country: "US", market: "N", network: `NETWORK-${i}` })),
    }));
    expect(buildScheduleMessage({ date: "2026-10-10", games: busy }).embeds![0]!.description!.length).toBeLessThanOrEqual(4000);
  });

  it("explains the team tags and says which country's channels it shows", () => {
    const games = day("2026-10-10");
    const footer = (country?: "US" | "CA") => buildScheduleMessage({ date: "2026-10-10", games, country }).embeds![0]!.footer!.text;
    expect(footer()).toBe("Times are in your time zone · TV from NHL.com · (TEAM) = that team's local channel");
    expect(footer("US")).toContain("US TV from NHL.com");
  });

  it("titles a team's schedule with the team and its colour", () => {
    const embed = buildScheduleMessage({ date: "2026-10-10", games: [game("2026-10-10", "TOR", "COL")], team: "TOR" }).embeds![0]!;
    expect(embed.title).toBe("🏒 Toronto Maple Leafs · Saturday, Oct 10");
    expect(embed.color).toBe(0x00205b);
  });

  it("says when the schedule picks up again", () => {
    const next = (opts: object) => buildScheduleMessage({ date: "2026-07-20", games: [], ...opts }).embeds![0]!.description;
    expect(next({ nextDay: "2026-07-22" })).toBe("No games. Next games: **Wednesday, Jul 22**.");
    expect(next({ nextWeek: "2026-09-14" })).toBe("No games. Next games: the week of **Monday, Sep 14**.");
    expect(next({})).toBe("No games.");
  });
});
