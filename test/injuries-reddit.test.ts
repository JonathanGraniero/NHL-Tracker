import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyInjury, matchRoster } from "../src/injuries/reddit";
import { runInjuryCheck } from "../src/injuries/tracker";
import { runScan } from "../src/news/pipeline";
import { getRoster } from "../src/db/rosters";
import { openEpisodes } from "../src/db/injuries";
import { ALL_TEAMS, upsertSubscription } from "../src/db/subscriptions";
import type { MessageBody } from "../src/discord/api";
import type { NhlRosterResponse, RosterPlayer } from "../src/sources/nhl";
import type { EspnInjuriesResponse } from "../src/sources/espn-injuries";
import type { SourceItem } from "../src/sources/reddit";
import { createTestD1 } from "./helpers/d1";
import { createTestBot, requestJson, type TestBot } from "./helpers/discord";
import { espnEntry, espnResponse } from "./helpers/espn";

// Real r/hockey titles from September 2026.
const REAL = {
  korpisalo: "[Walker] NYR putting Joonas Korpisalo on IR. He's week-to-week with a lower-body injury. [NY Rangers PR] Dylan Garand has been recalled",
  larkin: "[Galli] Dylan Larkin is out for the Red Wings first two games, Todd McLellan announced. McLellan said they “hope” he could return soon",
  faber: "[Russo] Wild top-pair defenseman Brock Faber sustained a fractured skull and underwent surgery. No timetable yet, Bill Guerin said",
  chytil: "[Vancouver Canucks] General Manager Ryan Johnson announced today that F Filip Chytil has been placed on IR (retroactive to Sept. 28)",
  barzal: "[Islanders] Mathew Barzal will not skate the next two weeks due to aggravation of a prior injury that has caused some inflammation.",
  guhle: "[Canadiens Montreal] Medical update: Defenseman Kaiden Guhle underwent a minor surgery to his adductor muscle this summer. He is expected to return in four to five weeks.",
};

describe("classifyInjury", () => {
  it.each([
    [REAL.korpisalo, "ir", ["NYR"], "Walker"],
    [REAL.larkin, "out", ["DET"], "Galli"],
    [REAL.faber, "out", ["MIN"], "Russo"],
    [REAL.chytil, "ir", ["VAN"], "Vancouver Canucks"],
    [REAL.barzal, "out", ["NYI"], "New York Islanders"],
    [REAL.guhle, "out", ["MTL"], "Canadiens Montreal"],
  ])("%s", (title, status, teams, reporter) => {
    expect(classifyInjury({ title, links: [] })).toMatchObject({ kind: "candidate", status, teams, reporter });
  });

  it("reads the injury when the post names it", () => {
    expect(classifyInjury({ title: REAL.korpisalo, links: [] })).toMatchObject({ injury: "Lower body" });
    expect(classifyInjury({ title: REAL.faber, links: [] })).toMatchObject({ injury: "Skull" });
  });

  it.each([
    // In-game scares and evaluations aren't confirmed.
    ["[McLaughlin] Dan Vladar leaving the game with an apparent injury. Aleksei Kolosov in.", "injury not confirmed"],
    ["[Engleson] Per Florida Panthers HC Paul Maurice, Aleksander Barkov will be evaluated tomorrow. Maurice said the injury is “not related to his injury last year at all,” adding, “We’ll have a good idea by tomorrow afternoon.”", "injury not confirmed"],
    ["[Erlendsson] Tampa Bay GM Julien BriseBois said Yanni Gourde had hip surgery in the summer and expected to be out until December", "injury not confirmed"],
    // Quotes are people talking, not statuses.
    ['[Wild] Guerin on Faber’s injury: "It\'s always going to affect your team when guys like that are out."', "without a firm status"],
    ["[Pittsburgh Penguins] Kyle Dubas on Evgeni Malkin. “I’m not gonna do this day to day, year by year thing with Geno again this year.”", "without a firm status"],
    // No source, or a game clip.
    ["Adam Sykora out 4-5 months in crushing injury blow for promising Rangers prospect", "without a named reporter"],
    ["[TOR-MTL] Jake McCabe left the game with an apparent injury after this collision", "without a named reporter"],
    // No team to check the name against.
    ["[Richards] Brady Tkachuk is day to day per Paul Maurice; said there is no concern for Tuesday’s opener.", "without an NHL team named"],
  ])("rejects %s", (title, reason) => {
    const v = classifyInjury({ title, links: [] });
    expect(v.kind).toBe("rejected");
    expect(v.kind === "rejected" && v.reason).toContain(reason);
  });

  it("leaves posts that aren't about injuries alone", () => {
    expect(classifyInjury({ title: "[Friedman] Columbus: Knies, Lorentz, Andrae and a 2nd Tor: Marchenko", links: [] })).toEqual({ kind: "not-injury" });
  });
});

describe("matchRoster", () => {
  const roster: RosterPlayer[] = [
    { name: "Mat Barzal", position: "C" },
    { name: "Bo Horvat", position: "C" },
    { name: "Noah Dobson", position: "D" },
    { name: "Simon Holmstrom", position: "R" },
    { name: "Anders Lee", position: "L" },
    { name: "Grant Lee", position: "D" },
  ];
  it.each([
    [["Bo Horvat"], "Bo Horvat"],
    [["Mathew Barzal"], "Mat Barzal"], // same surname and initial
    [["Dobson"], "Noah Dobson"], // lone surname, unique
    [["Simon Holmström"], "Simon Holmstrom"], // accents
    [["Bill Guerin", "Bo Horvat"], "Bo Horvat"], // first name that's on the roster
  ])("%j → %s", (names, expected) => {
    expect(matchRoster(roster, names)?.name).toBe(expected);
  });
  it.each([[["Lee"]], [["Brian Dobson"]], [["Bill Guerin"]]])("no match for %j", (names) => {
    expect(matchRoster(roster, names)).toBeUndefined();
  });
});

// --- End to end: the 2-minute scan, ESPN check and Discord -----------------

const T0 = Date.parse("2026-10-02T15:00:00Z");
const MIN = 60_000;

let db: D1Database;
let bot: TestBot;
let feed: SourceItem[];
let espn: EspnInjuriesResponse;
let rosterCalls: string[];
let nhlStatus: number;
let sent: { channelId: string; body: MessageBody; id: string }[];
let edited: { channelId: string; body: MessageBody }[];
let replyEdits: MessageBody[];

const ROSTERS: Record<string, string[]> = {
  MIN: ["Brock Faber", "Kirill Kaprizov", "Joel Eriksson Ek"],
  NYR: ["Joonas Korpisalo", "Igor Shesterkin", "Dylan Garand"],
};

function rosterResponse(team: string): NhlRosterResponse {
  return {
    forwards: (ROSTERS[team] ?? []).map((n) => ({
      firstName: { default: n.split(" ")[0]! },
      lastName: { default: n.split(" ").slice(1).join(" ") },
      positionCode: "D",
    })),
  };
}

function rssFeed(items: SourceItem[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<feed>${[...items]
    .reverse()
    .map(
      (i) =>
        `<entry><content type="html"></content><id>${i.id}</id><link href="${i.url}" /><published>${new Date(i.publishedAt).toISOString()}</published><title>${esc(i.title)}</title></entry>`,
    )
    .join("")}</feed>`;
}

const post = (id: string, title: string, at: number): SourceItem => ({
  source: "reddit",
  id,
  title,
  url: `https://www.reddit.com/r/hockey/comments/${id.slice(3)}/x/`,
  links: [],
  publishedAt: at,
});

beforeEach(async () => {
  db = createTestD1();
  bot = await createTestBot(db);
  feed = [];
  espn = espnResponse([]);
  rosterCalls = [];
  nhlStatus = 200;
  sent = [];
  edited = [];
  replyEdits = [];
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://www.reddit.com/r/hockey/new.rss")) return new Response(rssFeed(feed));
    if (url.includes("reddit.com/by_id/t3_faber")) return new Response(rssFeed([post("t3_faber", REAL.faber, T0)]));
    if (url.includes("/webhooks/") && init?.method === "PATCH") {
      replyEdits.push(requestJson<MessageBody>(init));
      return Response.json({});
    }
    if (url.startsWith("https://site.api.espn.com/")) return Response.json(espn);
    const roster = url.match(/api-web\.nhle\.com\/v1\/roster\/([A-Z]+)\/current/);
    if (roster) {
      rosterCalls.push(roster[1]!);
      return nhlStatus === 200 ? Response.json(rosterResponse(roster[1]!)) : new Response("down", { status: nhlStatus });
    }
    const edit = url.match(/discord\.com\/api\/v10\/channels\/([^/]+)\/messages\/([^/]+)$/);
    if (edit && init?.method === "PATCH") {
      edited.push({ channelId: edit[1]!, body: requestJson<MessageBody>(init) });
      return Response.json({ id: edit[2] });
    }
    const channel = url.match(/discord\.com\/api\/v10\/channels\/([^/]+)\/messages$/);
    if (channel) {
      const id = `msg-${sent.length + 1}`;
      sent.push({ channelId: channel[1]!, body: requestJson<MessageBody>(init), id });
      return Response.json({ id });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  await upsertSubscription(db, { guildId: "g1", channelId: "wild", teamCode: "MIN", types: ["trade", "injuries"] });
  await upsertSubscription(db, { guildId: "g1", channelId: "league", teamCode: ALL_TEAMS, types: ["injuries"] });
  await upsertSubscription(db, { guildId: "g1", channelId: "wild-trades", teamCode: "MIN", types: ["trade"] });

  // Both feeds start quiet: the first scan and the first ESPN check only record a baseline.
  await runScan(bot.env, T0);
  await runInjuryCheck(bot.env, T0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("breaking injury news from r/hockey", () => {
  it("posts the scoop, credits the reporter, and only to injury subscribers", async () => {
    feed = [post("t3_faber", REAL.faber, T0 + MIN)];
    await runScan(bot.env, T0 + 2 * MIN);

    expect(sent.map((s) => s.channelId).sort()).toEqual(["league", "wild"]);
    const embed = sent[0]!.body.embeds![0]!;
    expect(embed.title).toBe("🩹 Brock Faber (D) · Minnesota Wild");
    expect(embed.url).toBe("https://www.reddit.com/r/hockey/comments/faber/x/");
    expect(embed.description).toContain("**Out** · skull");
    expect(embed.description).toContain("First reported by **Russo** · [r/hockey]");
  });

  it("edits the scoop when ESPN confirms it, and replies when ESPN moves him to IR", async () => {
    feed = [post("t3_faber", REAL.faber, T0 + MIN)];
    await runScan(bot.env, T0 + 2 * MIN);

    espn = espnResponse([espnEntry({ player: "Brock Faber", team: "MIN", status: "O", body: "Skull", position: "D" })]);
    await runInjuryCheck(bot.env, T0 + 10 * MIN);
    expect(sent).toHaveLength(2);
    expect(edited.map((e) => e.channelId).sort()).toEqual(["league", "wild"]);
    expect(edited[0]!.body.embeds![0]!.description).toContain("✓ confirmed by ESPN");

    espn = espnResponse([espnEntry({ player: "Brock Faber", team: "MIN", status: "IR", body: "Skull", position: "D" })]);
    await runInjuryCheck(bot.env, T0 + 20 * MIN);
    const replies = sent.slice(2);
    expect(replies.map((r) => r.body.embeds![0]!.title)).toEqual(["📈 Brock Faber (D) · Minnesota Wild", "📈 Brock Faber (D) · Minnesota Wild"]);
    expect(replies.every((r) => r.body.message_reference)).toBe(true);
  });

  it("stays quiet when another reporter covers the same injury", async () => {
    feed = [post("t3_faber", REAL.faber, T0 + MIN)];
    await runScan(bot.env, T0 + 2 * MIN);
    feed.push(post("t3_faber2", "[Wild] Brock Faber (skull) placed on injured reserve", T0 + 3 * MIN));
    await runScan(bot.env, T0 + 4 * MIN);

    // Out → IR is more serious, so that one is a reply, not a second "new injury".
    expect(sent.map((s) => s.body.embeds![0]!.title)).toEqual([
      "🩹 Brock Faber (D) · Minnesota Wild",
      "🩹 Brock Faber (D) · Minnesota Wild",
      "📈 Brock Faber (D) · Minnesota Wild",
      "📈 Brock Faber (D) · Minnesota Wild",
    ]);
    feed.push(post("t3_faber3", "[Smith] Wild put Brock Faber on IR", T0 + 5 * MIN));
    await runScan(bot.env, T0 + 6 * MIN);
    expect(sent).toHaveLength(4);
  });

  it("stays quiet when ESPN already had it", async () => {
    espn = espnResponse([espnEntry({ player: "Brock Faber", team: "MIN", status: "O", position: "D" })]);
    await runInjuryCheck(bot.env, T0 + 10 * MIN);
    expect(sent).toHaveLength(2);

    feed = [post("t3_faber", REAL.faber, T0 + 11 * MIN)];
    await runScan(bot.env, T0 + 12 * MIN);
    expect(sent).toHaveLength(2);
    // …but the post picks up the r/hockey thread and reporter.
    expect(edited.at(-1)!.body.embeds![0]!.description).toContain("[r/hockey](https://www.reddit.com/r/hockey/comments/faber/x/)");
  });

  it("ignores a name that isn't on the team", async () => {
    feed = [post("t3_fake", "[Someone] Wild placing Connor McDavid on IR", T0 + MIN)];
    await runScan(bot.env, T0 + 2 * MIN);
    expect(sent).toEqual([]);
    expect(await openEpisodes(db, ["MIN"])).toEqual([]);
  });

  it("records day-to-day without posting it", async () => {
    feed = [post("t3_dtd", "[Russo] Kirill Kaprizov is day-to-day for the Wild with a lower-body injury", T0 + MIN)];
    await runScan(bot.env, T0 + 2 * MIN);
    expect(sent).toEqual([]);
    expect((await openEpisodes(db, ["MIN"]))[0]).toMatchObject({ player: "Kirill Kaprizov", status: "day-to-day" });
  });

  it("caches rosters for a day", async () => {
    feed = [post("t3_a", "[Russo] Wild placing Brock Faber on IR", T0 + MIN)];
    await runScan(bot.env, T0 + 2 * MIN);
    feed.push(post("t3_b", "[Russo] Wild placing Joel Eriksson Ek on IR", T0 + 3 * MIN));
    await runScan(bot.env, T0 + 4 * MIN);
    expect(rosterCalls).toEqual(["MIN"]);
  });
});

it("skips an injury post rather than stalling the scan when NHL.com is down", async () => {
  nhlStatus = 503;
  feed = [
    post("t3_faber", REAL.faber, T0 + MIN),
    post("t3_trade", "[Friedman] Columbus: Knies, Lorentz, Andrae and a 2nd Tor: Marchenko, Miles Wood, Merzlikins", T0 + MIN),
  ];
  await upsertSubscription(db, { guildId: "g1", channelId: "leafs", teamCode: "TOR", types: ["trade"] });
  await expect(runScan(bot.env, T0 + 2 * MIN)).resolves.toBeUndefined();
  expect(sent.map((s) => s.channelId)).toEqual(["leafs"]); // the trade still went out
  expect(await openEpisodes(db, ["MIN"])).toEqual([]);
});

describe("getRoster", () => {
  it("uses a stale roster when NHL.com is down, and fails only with nothing cached", async () => {
    expect((await getRoster(db, "NYR", T0)).map((p) => p.name)).toContain("Joonas Korpisalo");
    nhlStatus = 503;
    expect((await getRoster(db, "NYR", T0 + 2 * 24 * 60 * MIN)).map((p) => p.name)).toContain("Joonas Korpisalo");
    await expect(getRoster(db, "BOS", T0)).rejects.toThrow("503");
  });
});

describe("/replay on an injury post", () => {
  it("previews without posting", async () => {
    await bot.send({
      id: "1",
      application_id: "123",
      token: "tok",
      type: 2,
      guild_id: "g1",
      channel_id: "wild",
      data: { name: "replay", options: [{ name: "post", type: 3, value: "t3_faber" }] },
    });
    await bot.settle();
    expect(replyEdits[0]?.content).toContain("🩹 **Would record an injury:** Brock Faber (Minnesota Wild) · Out, first reported by **Russo**.");
    expect(sent).toEqual([]);
    expect(await openEpisodes(db, ["MIN"])).toEqual([]);
  });
});
