import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { ALL_TEAMS, upsertSubscription } from "../src/db/subscriptions";
import { MAX_AGE_MS, processItem, runScan } from "../src/news/pipeline";
import { parseFeed, type SourceItem } from "../src/sources/reddit";
import { parseStories } from "../src/sources/nhl-news";
import { createTestD1 } from "./helpers/d1";
import { createTestBot, requestJson, type TestBot } from "./helpers/discord";
import { FakeClaude } from "./helpers/model";
import type { MessageBody } from "../src/discord/api";

const KNIES_FEED = readFileSync(join(import.meta.dirname, "fixtures/knies-search.xml"), "utf8");
const FRIEDMAN_TRADE_ID = "t3_1wsqy36";
const LEBRUN_NOT_DONE_ID = "t3_1wsmli2";
const TRADE_TIME = Date.parse("2026-09-28T21:07:00Z");

/** Builds a Reddit Atom feed the way Reddit escapes it. */
function feed(items: SourceItem[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const entries = items.map((i) => {
    const html = i.links.map((l) => `<a href="${esc(l)}">link</a>`).join(" ");
    return `<entry><content type="html">${esc(html)}</content><id>${i.id}</id><link href="${i.url}" /><updated>${new Date(i.publishedAt).toISOString()}</updated><published>${new Date(i.publishedAt).toISOString()}</published><title>${esc(i.title)}</title></entry>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.join("")}</feed>`;
}

const post = (id: string, title: string, publishedAt: number, links: string[] = []): SourceItem => ({
  source: "reddit",
  id,
  title,
  url: `https://www.reddit.com/r/hockey/comments/${id.slice(3)}/x/`,
  links,
  publishedAt,
});

const knies = parseFeed(KNIES_FEED);
const friedmanTrade = knies.find((i) => i.id === FRIEDMAN_TRADE_ID)!;
const lebrunNotDone = knies.find((i) => i.id === LEBRUN_NOT_DONE_ID)!;
const MAPLE_LEAFS_TRADE = "[Maple Leafs] The Maple Leafs have acquired Matthew Knies' replacement Kirill Marchenko from Columbus";
const LEAFS_CANUCKS_STORY = "Maple Leafs complete trade with Vancouver";
const FRIEDMAN_LEAFS_CANUCKS = "[Friedman] Vancouver: Player One and a 3rd Tor: Player Two";
const BRISSON = "[Friedman] Leafs sign Brendan Brisson to a one year contract";
const KNIES_SIGNING = "[Friedman] Leafs sign Matthew Knies to a two year contract";

let db: D1Database;
let bot: TestBot;
let redditFeed: SourceItem[];
let redditStatus: number;
let sent: { channelId: string; body: MessageBody }[];
let edits: MessageBody[];
let claude: FakeClaude;

beforeEach(async () => {
  db = createTestD1();
  bot = await createTestBot(db);
  claude = new FakeClaude()
    .answer(friedmanTrade.title, { move: "trade", players: ["Knies", "Lorentz", "Andrae", "Marchenko", "Miles Wood", "Merzlikins"] })
    .answer(lebrunNotDone.title, { move: "trade", done: false, reason: "says it's not a done deal yet" })
    .answer(MAPLE_LEAFS_TRADE, { move: "trade", players: ["Kirill Marchenko"] })
    .answer(LEAFS_CANUCKS_STORY, { move: "trade" })
    .answer(FRIEDMAN_LEAFS_CANUCKS, { move: "trade", players: ["Player One", "Player Two"] })
    .answer(BRISSON, { move: "signing", players: ["Brendan Brisson"] })
    .answer(KNIES_SIGNING, { move: "signing", players: ["Matthew Knies"] });
  redditFeed = [];
  redditStatus = 200;
  sent = [];
  edits = [];
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (claude.handles(url)) return claude.respond(init);
    if (url.startsWith("https://forge-dapi.d3.nhle.com/")) return Response.json({ items: [] }); // NHL.com news: quiet
    if (url.startsWith("https://www.reddit.com/r/hockey/new.rss")) {
      return new Response(feed([...redditFeed].reverse()), { status: redditStatus });
    }
    const byId = url.match(/reddit\.com\/by_id\/(t3_\w+)\.rss/);
    if (byId) return new Response(feed(knies.filter((i) => i.id === byId[1])), { status: redditStatus });
    const channel = url.match(/discord\.com\/api\/v10\/channels\/([^/]+)\/messages/);
    if (channel) {
      if (channel[1] === "no-access") return new Response('{"message":"Missing Access"}', { status: 403 });
      sent.push({ channelId: channel[1]!, body: requestJson<MessageBody>(init) });
      return Response.json({ id: `msg-${sent.length}` });
    }
    if (url.includes("/webhooks/") && init?.method === "PATCH") {
      edits.push(requestJson<MessageBody>(init));
      return Response.json({});
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const sub = (guildId: string, channelId: string, teamCode: string, types = ["trade", "waiver", "signing"] as const) =>
    upsertSubscription(db, { guildId, channelId, teamCode, types });
  await sub("g1", "leafs", "TOR");
  await sub("g1", "jackets", "CBJ");
  await sub("g1", "isles", "NYI");
  await sub("g1", "leafs-signings", "TOR", ["signing"] as never);
  await sub("g2", "league", ALL_TEAMS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** First scan only marks what's already on the feed, so run it once before the news arrives. */
async function primeScanner(now: number) {
  redditFeed = [post("t3_old", "[Friedman] Old news, already on the feed", now - 60_000)];
  await runScan(bot.env, now);
  expect(sent).toEqual([]);
}

describe("runScan", () => {
  it("posts nothing on the first run, even confirmed moves already on the feed", async () => {
    redditFeed = [friedmanTrade];
    await runScan(bot.env, TRADE_TIME + 60_000);
    expect(sent).toEqual([]);
  });

  it("posts a confirmed trade to every channel following either team, once", async () => {
    await primeScanner(TRADE_TIME - 60_000);
    redditFeed = knies.filter((i) => Math.abs(i.publishedAt - TRADE_TIME) < 3 * 60 * 60 * 1000);
    await runScan(bot.env, TRADE_TIME + 60_000);

    expect(sent.map((s) => s.channelId).sort()).toEqual(["jackets", "leafs", "league"]);
    const embed = sent[0]!.body.embeds![0]!;
    expect(embed.title).toBe("🔁 Trade: Columbus Blue Jackets ↔ Toronto Maple Leafs");
    expect(embed.url).toBe("https://x.com/FriedgeHNIC/status/2104679097859448993");

    await runScan(bot.env, TRADE_TIME + 120_000);
    expect(sent).toHaveLength(3);
  });

  it("treats a later report of the same trade as a duplicate", async () => {
    await primeScanner(TRADE_TIME - 60_000);
    redditFeed = [friedmanTrade];
    await runScan(bot.env, TRADE_TIME + 60_000);
    redditFeed.push(post("t3_team", MAPLE_LEAFS_TRADE, TRADE_TIME + 30 * 60_000));
    await runScan(bot.env, TRADE_TIME + 31 * 60_000);
    expect(sent).toHaveLength(3);
  });

  it("skips posts that are too old", async () => {
    await primeScanner(TRADE_TIME - 60_000);
    redditFeed = [friedmanTrade];
    await runScan(bot.env, TRADE_TIME + MAX_AGE_MS + 1);
    expect(sent).toEqual([]);
  });

  it("waits for the next run when Reddit rate-limits", async () => {
    await primeScanner(TRADE_TIME - 60_000);
    redditFeed = [friedmanTrade];
    redditStatus = 429;
    await expect(runScan(bot.env, TRADE_TIME + 60_000)).resolves.toBeUndefined();
    expect(sent).toEqual([]);

    redditStatus = 200;
    await runScan(bot.env, TRADE_TIME + 3 * 60_000);
    expect(sent).toHaveLength(3);
  });

  it("asks Claude only about posts from trusted sources that name a team", async () => {
    await primeScanner(TRADE_TIME - 60_000);
    redditFeed = knies.filter((i) => Math.abs(i.publishedAt - TRADE_TIME) < 3 * 60 * 60 * 1000);
    await runScan(bot.env, TRADE_TIME + 60_000);
    expect(claude.asked).toHaveLength(redditFeed.filter((i) => /^\[(Friedman|LeBrun)\]/.test(i.title)).length);
  });

  it("leaves posts for the next scan while Claude is down, after one failed call", async () => {
    await primeScanner(TRADE_TIME - 60_000);
    const waiver = post("t3_w", "[Friedman] Gaudet (STL) on waivers", TRADE_TIME);
    const fanPost = post("t3_fan", "Matthew Knies was traded by all 3 of his GMs in Toronto", TRADE_TIME);
    redditFeed = [friedmanTrade, waiver, fanPost];
    claude.status = 529;
    await runScan(bot.env, TRADE_TIME + 60_000);
    expect(sent).toEqual([]);
    expect(claude.asked).toHaveLength(1);

    claude.status = 200;
    await runScan(bot.env, TRADE_TIME + 3 * 60_000);
    expect(sent).toHaveLength(3);
    // The trade and the waiver post were asked about again; the fan post was settled without Claude.
    expect(claude.asked).toHaveLength(3);
    await runScan(bot.env, TRADE_TIME + 5 * 60_000);
    expect(claude.asked).toHaveLength(3);
  });

  it("asks Claude at most 15 times a scan and leaves the rest for the next one", async () => {
    await primeScanner(TRADE_TIME - 60_000);
    redditFeed = Array.from({ length: 17 }, (_, n) => post(`t3_w${n}`, `[Friedman] Player${n} (STL) on waivers`, TRADE_TIME));
    await runScan(bot.env, TRADE_TIME + 60_000);
    expect(claude.asked).toHaveLength(15);
    await runScan(bot.env, TRADE_TIME + 3 * 60_000);
    expect(claude.asked).toHaveLength(17);
  });
});

describe("processItem", () => {
  it("finishes the remaining channels if a run died partway through posting", async () => {
    await upsertSubscription(db, { guildId: "g1", channelId: "no-access", teamCode: "TOR", types: ["trade"] });
    const first = await processItem(bot.env, friedmanTrade, { now: TRADE_TIME });
    expect(first).toMatchObject({ kind: "posted", failed: ["no-access"] });
    expect(sent).toHaveLength(3);

    const again = await processItem(bot.env, friedmanTrade, { now: TRADE_TIME + 60_000 });
    expect(again).toMatchObject({ kind: "posted", channels: [] });
    expect(sent).toHaveLength(3);
  });

  describe("a verb-first trade headline on NHL.com (missed on 2026-10-14)", () => {
    const LEAFS_CANUCKS = Date.parse("2026-10-14T18:00:00Z");
    const [story] = parseStories({
      items: [
        {
          slug: "maple-leafs-complete-trade-with-vancouver-x8932",
          title: LEAFS_CANUCKS_STORY,
          contentDate: new Date(LEAFS_CANUCKS).toISOString(),
          context: { slug: "teamid-10" },
          tags: [{ slug: "teamid-10", title: "Toronto Maple Leafs" }],
        },
      ],
    });

    it("is posted to channels following either team", async () => {
      expect(story!.url).toBe("https://www.nhl.com/mapleleafs/news/maple-leafs-complete-trade-with-vancouver-x8932");
      expect(await processItem(bot.env, story!, { now: LEAFS_CANUCKS })).toMatchObject({
        kind: "posted",
        event: { type: "trade", teams: ["TOR", "VAN"], source: "NHL.com" },
      });
      expect(sent.map((s) => s.channelId).sort()).toEqual(["leafs", "league"]);
    });

    it("isn't posted again when an insider already reported the trade", async () => {
      const friedman = post("t3_f", FRIEDMAN_LEAFS_CANUCKS, LEAFS_CANUCKS - 20 * 60_000);
      expect(await processItem(bot.env, friedman, { now: LEAFS_CANUCKS - 20 * 60_000 })).toMatchObject({ kind: "posted" });
      expect(await processItem(bot.env, story!, { now: LEAFS_CANUCKS })).toMatchObject({ kind: "duplicate" });
      expect(sent).toHaveLength(2);
    });
  });

  it("keeps separate signings for the same team apart", async () => {
    const a = post("t3_a", BRISSON, TRADE_TIME);
    const b = post("t3_b", KNIES_SIGNING, TRADE_TIME + 60_000);
    expect(await processItem(bot.env, a, { now: TRADE_TIME })).toMatchObject({ kind: "posted" });
    expect(await processItem(bot.env, b, { now: TRADE_TIME })).toMatchObject({ kind: "posted" });
  });
});

describe("/replay", () => {
  it("defers, then posts a confirmed move only in this server", async () => {
    const res = await bot.send({
      id: "1",
      application_id: "123",
      token: "tok",
      type: 2,
      guild_id: "g1",
      channel_id: "leafs",
      data: { name: "replay", options: [{ name: "post", type: 3, value: "https://www.reddit.com/r/hockey/comments/1wsqy36/friedman/" }] },
    });
    expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });

    await bot.settle();
    expect(sent.map((s) => s.channelId).sort()).toEqual(["jackets", "leafs"]);
    expect(edits[0]?.content).toContain("✅ **Confirmed trade** (Columbus Blue Jackets ↔ Toronto Maple Leafs) from **Elliotte Friedman**");
    expect(edits[0]?.content).toContain("<#leafs>");
  });

  it("explains why a post wouldn't be posted", async () => {
    await bot.send({
      id: "2",
      application_id: "123",
      token: "tok",
      type: 2,
      guild_id: "g1",
      channel_id: "leafs",
      data: { name: "replay", options: [{ name: "post", type: 3, value: LEBRUN_NOT_DONE_ID }] },
    });
    await bot.settle();
    expect(sent).toEqual([]);
    expect(edits[0]?.content).toContain("Wouldn't post this:** not confirmed yet");
  });

  it("rejects input that isn't a Reddit post", async () => {
    expect(await bot.command("replay", { post: "the knies trade" }, { channelId: "leafs" })).toContain("doesn't look like an r/hockey post or NHL.com article");
  });
});

it("the cron handler runs a scan", async () => {
  await worker.scheduled({ cron: "*/2 * * * *", scheduledTime: TRADE_TIME, noRetry() {} } as ScheduledController, bot.env, bot.ctx);
  expect(await db.prepare("SELECT value FROM bot_state WHERE key = 'reddit_ready'").first("value")).toBe(String(TRADE_TIME));
});
