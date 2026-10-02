import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { standingsView } from "../src/discord/commands";
import { firstRound, standingsMessage } from "../src/standings/format";
import { parseStandings, type NhlStandingsResponse } from "../src/sources/nhl-standings";
import type { MessageBody } from "../src/discord/api";
import { createTestD1 } from "./helpers/d1";
import { createTestBot, requestJson, type TestBot } from "./helpers/discord";

// Real NHL.com standings: early 2026-27 (most teams 0–2 games), and the last
// day of 2025-26, with clinch markers and a full playoff field.
const load = (date: string): NhlStandingsResponse =>
  JSON.parse(readFileSync(join(import.meta.dirname, `fixtures/standings-${date}.json`), "utf8")) as NhlStandingsResponse;
const EARLY = load("2026-10-02");
const FINAL = load("2026-04-16");

/** The rows inside an embed's code block. */
const rows = (body: MessageBody, embed = 0) => body.embeds![embed]!.description!.split("```")[1]!.replace(/^\n|\n$/g, "").split("\n");

describe("parseStandings", () => {
  it("reads all 32 teams with NHL.com's ranks", () => {
    const { teams, updatedAt } = parseStandings(EARLY);
    expect(teams).toHaveLength(32);
    expect(new Set(teams.map((t) => t.leagueRank)).size).toBe(32);
    expect(updatedAt).toBe(Date.parse("2026-10-02T21:04:15Z"));
  });

  it("reads clinch markers", () => {
    const { teams } = parseStandings(FINAL);
    const byTeam = new Map(teams.map((t) => [t.team, t.clinch]));
    expect(byTeam.get("COL")).toBe("p");
    expect(byTeam.get("VGK")).toBe("y");
    expect(byTeam.get("VAN")).toBe("e");
    expect(teams.filter((t) => t.clinch === "e")).toHaveLength(16);
  });
});

describe("tables", () => {
  it("lists the league by NHL.com's order, with aligned columns", () => {
    const lines = rows(standingsMessage(parseStandings(FINAL), { kind: "league" }));
    expect(lines).toHaveLength(33);
    expect(lines[0]).toBe(" #  Team    GP  W-L-OT   PTS     P%");
    expect(lines[1]).toBe(" 1  p-COL   82  55-16-11 121   .738");
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
  });

  it("leaves out the clinch column until someone has clinched", () => {
    const lines = rows(standingsMessage(parseStandings(EARLY), { kind: "division", division: "Atlantic" }));
    expect(lines).toEqual([
      " #  Team  GP  W-L-OT   PTS     P%",
      " 1  FLA    2  1-0-1      3   .750",
      " 2  BOS    1  1-0-0      2  1.000",
      " 3  MTL    1  1-0-0      2  1.000",
      " 4  TOR    2  1-1-0      2   .500",
      " 5  DET    0  0-0-0      0    ---",
      " 6  OTT    0  0-0-0      0    ---",
      " 7  BUF    1  0-1-0      0   .000",
      " 8  TBL    1  0-1-0      0   .000",
    ]);
  });

  it("titles each view", () => {
    const s = parseStandings(EARLY);
    expect(standingsMessage(s, { kind: "league" }).embeds![0]!.title).toBe("🏒 NHL standings");
    expect(standingsMessage(s, { kind: "conference", conference: "Western" }).embeds![0]!.title).toBe("🏒 Western Conference standings");
    expect(rows(standingsMessage(s, { kind: "conference", conference: "Western" }))).toHaveLength(17);
  });

  it("explains clinch markers only when there are some", () => {
    expect(standingsMessage(parseStandings(FINAL), { kind: "league" }).embeds![0]!.footer!.text).toContain("x clinched");
    expect(standingsMessage(parseStandings(EARLY), { kind: "league" }).embeds![0]!.footer!.text).toBe(
      "Ranked by points with NHL tiebreakers · NHL.com",
    );
  });
});

describe("playoff picture", () => {
  const west = standingsMessage(parseStandings(FINAL), { kind: "playoffs", conferences: ["Western"] });

  it("shows each division's top three, the wild cards, then a cut line with points back", () => {
    const lines = rows(west);
    expect(lines.slice(1, 12).map((l) => l.trim().split(/\s+/).slice(0, 2).join(" "))).toEqual([
      "CENTRAL", "1 p-COL", "2 x-DAL", "3 x-MIN",
      "PACIFIC", "1 y-VGK", "2 x-EDM", "3 x-ANA",
      "WILD CARD", "1 x-UTA", "2 x-LAK",
    ]);
    expect(lines[12]).toMatch(/^─+$/);
    expect(lines[13]).toBe(" 3  e-STL   82  37-33-12  86   .524  -4");
    expect(lines.at(-1)).toBe("10  e-VAN   82  25-49-8   58   .354  -32");
  });

  it("gives the first round if the season ended today", () => {
    expect(west.embeds![0]!.description).toContain("**First round if the season ended today**\nCOL vs LAK\nVGK vs UTA\nDAL vs MIN\nEDM vs ANA");
    const { teams } = parseStandings(FINAL);
    // The division winner with more points (CAR) draws the second wild card.
    expect(firstRound(teams.filter((t) => t.conference === "Eastern"), "Eastern")).toEqual(["CAR vs OTT", "BUF vs BOS", "TBL vs MTL", "PIT vs PHI"]);
  });

  it("fits both conferences in one message", () => {
    const both = standingsMessage(parseStandings(FINAL), { kind: "playoffs", conferences: ["Eastern", "Western"] });
    expect(both.embeds!.map((e) => e.title)).toEqual(["🏆 Eastern Conference playoff picture", "🏆 Western Conference playoff picture"]);
    const total = both.embeds!.reduce((n, e) => n + e.title!.length + e.description!.length + (e.footer?.text.length ?? 0), 0);
    expect(total).toBeLessThan(6000);
  });

  it("works on opening week too", () => {
    const east = standingsMessage(parseStandings(EARLY), { kind: "playoffs", conferences: ["Eastern"] });
    // header, 2 division labels + 6 teams, wild-card label + 2, cut line, 8 more
    expect(rows(east)).toHaveLength(1 + 2 + 6 + 1 + 2 + 1 + 8);
    expect(east.embeds![0]!.description).toContain("First round if the season ended today");
  });
});

describe("standingsView", () => {
  it.each([
    [{}, { kind: "league" }],
    [{ conference: "Eastern" }, { kind: "conference", conference: "Eastern" }],
    [{ division: "Pacific" }, { kind: "division", division: "Pacific" }],
    [{ division: "Pacific", conference: "Western" }, { kind: "division", division: "Pacific" }],
    [{ playoffs: true }, { kind: "playoffs", conferences: ["Eastern", "Western"] }],
    [{ playoffs: true, conference: "Western" }, { kind: "playoffs", conferences: ["Western"] }],
    [{ playoffs: true, division: "Metropolitan" }, { kind: "playoffs", conferences: ["Eastern"] }],
    [{ playoffs: false, division: "Central" }, { kind: "division", division: "Central" }],
  ])("%j → %j", (options, view) => {
    expect(standingsView(options)).toEqual({ view });
  });

  it("rejects a division from the other conference", () => {
    expect(standingsView({ division: "Atlantic", conference: "Western" })).toEqual({
      error: "❌ The Atlantic Division is in the Eastern Conference, not the Western.",
    });
  });
});

describe("/standings", () => {
  let bot: TestBot;
  let nhlStatus: number;
  let replies: MessageBody[];

  beforeEach(async () => {
    bot = await createTestBot(createTestD1());
    nhlStatus = 200;
    replies = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://api-web.nhle.com/v1/standings/now") {
        return nhlStatus === 200 ? Response.json(FINAL) : new Response("down", { status: nhlStatus });
      }
      if (url.includes("/webhooks/") && init?.method === "PATCH") {
        replies.push(requestJson<MessageBody>(init));
        return Response.json({});
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const run = async (options: Record<string, string | boolean>) => {
    const res = await bot.send({
      id: "1",
      application_id: "123",
      token: "tok",
      type: 2,
      channel_id: "c",
      data: {
        name: "standings",
        options: Object.entries(options).map(([name, value]) => ({ name, type: typeof value === "boolean" ? 5 : 3, value })),
      },
    });
    return (await res.json()) as { type: number; data?: { content?: string; flags?: number } };
  };

  it("answers publicly, then shows the playoff picture", async () => {
    expect(await run({ playoffs: true })).toEqual({ type: 5 });
    await bot.settle();
    expect(replies[0]!.embeds!.map((e) => e.title)).toEqual([
      "🏆 Eastern Conference playoff picture",
      "🏆 Western Conference playoff picture",
    ]);
  });

  it("filters by division", async () => {
    await run({ division: "Central" });
    await bot.settle();
    expect(replies[0]!.embeds![0]!.title).toBe("🏒 Central Division standings");
  });

  it("explains a mismatched division and conference straight away, privately", async () => {
    const res = await run({ division: "Atlantic", conference: "Western" });
    expect(res.data).toEqual({ content: "❌ The Atlantic Division is in the Eastern Conference, not the Western.", flags: 64 });
    expect(replies).toEqual([]);
  });

  it("reports when NHL.com is down", async () => {
    nhlStatus = 503;
    await run({});
    await bot.settle();
    expect(replies[0]!.content).toContain("couldn't reach NHL.com");
  });
});
