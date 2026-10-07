import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classify } from "../src/news/classify";
import { runScan } from "../src/news/pipeline";
import { nhlComPath, TEAMS } from "../src/data/teams";
import { parseStories, storySlugFromUrl, storyUrl, type NhlStoriesResponse, type NhlStory } from "../src/sources/nhl-news";
import { ALL_TEAMS, upsertSubscription } from "../src/db/subscriptions";
import type { MessageBody } from "../src/discord/api";
import type { SourceItem } from "../src/sources/reddit";
import { createTestD1 } from "./helpers/d1";
import { createTestBot, requestJson, type TestBot } from "./helpers/discord";

// NHL.com's real "transactions" stories, 2026-09-27 to 2026-10-07.
const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/nhl-transactions-2026-10-07.json"), "utf8"),
) as Required<NhlStoriesResponse>;
const story = (slug: string) => FIXTURE.items.find((s) => s.slug === slug)!;

describe("parseStories", () => {
  const items = parseStories(FIXTURE);

  it("reads every story", () => {
    expect(items).toHaveLength(30);
    expect(items.every((i) => i.source === "nhl" && i.id.startsWith("nhl:"))).toBe(true);
  });

  it("links each story to its page on nhl.com", () => {
    expect(items.find((i) => i.id === "nhl:islanders-sign-dravecky")).toEqual({
      source: "nhl",
      id: "nhl:islanders-sign-dravecky",
      title: "Islanders Sign Dravecky",
      url: "https://www.nhl.com/islanders/news/islanders-sign-dravecky",
      links: ["https://www.nhl.com/islanders/news/islanders-sign-dravecky"],
      publishedAt: Date.parse("2026-10-07T14:29:13.682Z"),
    });
    // NHL.com's own stories live under /news.
    expect(items.find((i) => i.title.startsWith("Maple Leafs acquire Kirill Marchenko"))?.url).toMatch(
      /^https:\/\/www\.nhl\.com\/news\/maple-leafs-acquire-kirill-marchenko/,
    );
    // Accent-free team tag ("Montreal Canadiens").
    expect(items.find((i) => i.title === "Jacob Fowler recalled from Laval Rocket")?.url).toMatch(/^https:\/\/www\.nhl\.com\/canadiens\/news\//);
  });

  it("uses the headline when a story's title is just its slug", () => {
    const slugTitled: NhlStory = { slug: "kings-unveil-display", title: "kings-unveil-display", headline: "Kings unveil display", contentDate: "2026-10-07T22:39:57Z" };
    expect(parseStories({ items: [slugTitled] })[0]?.title).toBe("Kings unveil display");
  });

  it("falls back to /news for an unknown team", () => {
    expect(storyUrl({ slug: "x", title: "x y", contentDate: "", context: { slug: "teamid-99" }, tags: [{ slug: "teamid-99", title: "Quebec Nordiques" }] })).toBe(
      "https://www.nhl.com/news/x",
    );
  });
});

describe("nhlComPath", () => {
  it.each([
    ["NYI", "islanders"],
    ["TOR", "mapleleafs"],
    ["CBJ", "bluejackets"],
    ["VGK", "goldenknights"],
    ["DET", "redwings"],
    ["MTL", "canadiens"],
    ["STL", "blues"],
    ["UTA", "utah"], // nhl.com/mammoth doesn't exist
  ])("%s → %s", (code, path) => {
    expect(nhlComPath(code)).toBe(path);
  });

  it("has a path for every team", () => {
    expect(TEAMS.every((t) => /^[a-z]+$/.test(nhlComPath(t.code) ?? ""))).toBe(true);
  });
});

describe("which NHL.com stories are moves", () => {
  it("picks out the signings, trades and waivers, and skips recalls and roster news", () => {
    const moves = parseStories(FIXTURE).flatMap((i) => {
      const v = classify(i);
      return v.confirmed ? [`${v.type} ${v.teams.join("/")}: ${i.title}`] : [];
    });
    expect(moves).toEqual([
      "signing NYI: Islanders Sign Dravecky",
      "signing PHI: FLYERS SIGN MICHAEL BUNTING TO ONE-YEAR CONTRACT",
      "trade PHI/SEA: FLYERS ACQUIRE DAVID GOYETTE FROM SEATTLE",
      "signing VGK: Golden Knights Sign William Karlsson to Two-Year Contract Extension",
      "waiver CAR: Canes Place Primeau On Waivers",
      "trade TOR/CBJ: Maple Leafs acquire Kirill Marchenko in trade with Blue Jackets for Matthew Knies",
      "signing NSH: Predators Sign Tyson Jost to One-Year, Two-Way Contract - 2026_09-28",
      "signing FLA: Florida Panthers Agree to Terms with Forward Nathan Bastian on a One-Year, Two-Way Contract",
      "waiver NJD: 6 Placed on Waivers | TRANSACTIONS 9.27.26",
    ]);
  });
});

// --- The scan, with both sources ---------------------------------------------

const T0 = Date.parse("2026-10-07T14:00:00Z");
const MIN = 60_000;

let db: D1Database;
let bot: TestBot;
let nhlStories: NhlStory[];
let redditPosts: SourceItem[];
let nhlStatus: number;
let redditStatus: number;
let sent: { channelId: string; body: MessageBody }[];
let replies: MessageBody[];

function rss(items: SourceItem[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<feed>${[...items]
    .reverse()
    .map((i) => `<entry><content type="html"></content><id>${i.id}</id><link href="${i.url}" /><published>${new Date(i.publishedAt).toISOString()}</published><title>${esc(i.title)}</title></entry>`)
    .join("")}</feed>`;
}

/** A fixture story, republished at `at` (the scan skips anything over 6 hours old). */
const fresh = (slug: string, at: number): NhlStory => ({ ...story(slug), contentDate: new Date(at).toISOString() });

beforeEach(async () => {
  db = createTestD1();
  bot = await createTestBot(db);
  nhlStories = [];
  redditPosts = [];
  nhlStatus = 200;
  redditStatus = 200;
  sent = [];
  replies = [];
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const single = url.match(/forge-dapi\.d3\.nhle\.com\/v2\/content\/en-us\/stories\/([a-z0-9-]+)$/);
    if (single) {
      const found = FIXTURE.items.find((s) => s.slug === single[1]);
      return found ? Response.json(found) : new Response("not found", { status: 404 });
    }
    if (url.includes("/webhooks/") && init?.method === "PATCH") {
      replies.push(requestJson<MessageBody>(init));
      return Response.json({});
    }
    if (url.startsWith("https://forge-dapi.d3.nhle.com/")) {
      // Newest first, like the real API.
      const items = [...nhlStories].sort((a, b) => b.contentDate.localeCompare(a.contentDate));
      return nhlStatus === 200 ? Response.json({ items }) : new Response("down", { status: nhlStatus });
    }
    if (url.startsWith("https://www.reddit.com/r/hockey/new.rss")) {
      return redditStatus === 200 ? new Response(rss(redditPosts)) : new Response("busy", { status: redditStatus });
    }
    const channel = url.match(/discord\.com\/api\/v10\/channels\/([^/]+)\/messages$/);
    if (channel) {
      sent.push({ channelId: channel[1]!, body: requestJson<MessageBody>(init) });
      return Response.json({ id: `msg-${sent.length}` });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  await upsertSubscription(db, { guildId: "g1", channelId: "league", teamCode: ALL_TEAMS, types: ["trade", "waiver", "signing"] });
  await upsertSubscription(db, { guildId: "g1", channelId: "isles", teamCode: "NYI", types: ["signing"] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scanning NHL.com", () => {
  it("records what's already there on the first run without posting it", async () => {
    nhlStories = [fresh("islanders-sign-dravecky", T0 - MIN)];
    await runScan(bot.env, T0);
    expect(sent).toEqual([]);
    expect(await db.prepare("SELECT value FROM bot_state WHERE key = 'nhl_news_ready'").first("value")).toBe(String(T0));
  });

  it("posts a team's signing that never reached r/hockey, linking the article", async () => {
    await runScan(bot.env, T0);
    nhlStories = [fresh("islanders-sign-dravecky", T0 + 29 * MIN)];
    await runScan(bot.env, T0 + 30 * MIN);

    expect(sent.map((s) => s.channelId).sort()).toEqual(["isles", "league"]);
    const embed = sent[0]!.body.embeds![0]!;
    expect(embed.title).toBe("✍️ Signing: New York Islanders");
    expect(embed.url).toBe("https://www.nhl.com/islanders/news/islanders-sign-dravecky");
    expect(embed.fields).toEqual([{ name: "Source", value: "NHL.com", inline: true }]);

    await runScan(bot.env, T0 + 32 * MIN);
    expect(sent).toHaveLength(2);
  });

  it("doesn't repeat a move r/hockey already broke", async () => {
    await runScan(bot.env, T0);
    redditPosts = [
      {
        source: "reddit",
        id: "t3_bunting",
        title: "[Dreger] The Flyers are bringing in Michael Bunting for some spark. Deal agreed to at $1.2 mil. AAV.",
        url: "https://www.reddit.com/r/hockey/comments/bunting/x/",
        links: [],
        publishedAt: T0 + MIN,
      },
    ];
    await runScan(bot.env, T0 + 2 * MIN);
    expect(sent.map((s) => s.channelId)).toEqual(["league"]);

    // The Flyers' own announcement, hours later.
    nhlStories = [fresh("flyers-sign-michael-bunting-to-one-year-contract", T0 + 3 * 60 * MIN)];
    await runScan(bot.env, T0 + 3 * 60 * MIN + MIN);
    expect(sent).toHaveLength(1);
  });

  it("keeps scanning r/hockey when NHL.com is down, and vice versa", async () => {
    await runScan(bot.env, T0);
    nhlStatus = 503;
    redditPosts = [
      { source: "reddit", id: "t3_x", title: "[Friedman] Canes Place Primeau On Waivers", url: "https://www.reddit.com/r/hockey/comments/x/y/", links: [], publishedAt: T0 + MIN },
    ];
    await expect(runScan(bot.env, T0 + 2 * MIN)).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);

    nhlStatus = 200;
    redditStatus = 429;
    nhlStories = [fresh("islanders-sign-dravecky", T0 + 3 * MIN)];
    await expect(runScan(bot.env, T0 + 4 * MIN)).resolves.toBeUndefined();
    expect(sent).toHaveLength(3);
  });

  it("skips recalls and roster news", async () => {
    await runScan(bot.env, T0);
    nhlStories = [fresh("jacob-fowler-recalled-from-laval-rocket", T0 + MIN), fresh("islanders-announce-23-man-roster-for-2026-27-season", T0 + MIN)];
    await runScan(bot.env, T0 + 2 * MIN);
    expect(sent).toEqual([]);
  });
});

describe("/replay with an NHL.com article", () => {
  const replay = (post: string) =>
    bot.send({
      id: "1",
      application_id: "123",
      token: "tok",
      type: 2,
      guild_id: "g1",
      channel_id: "isles",
      data: { name: "replay", options: [{ name: "post", type: 3, value: post }] },
    });

  it.each([
    ["https://www.nhl.com/islanders/news/islanders-sign-dravecky", "islanders-sign-dravecky"],
    ["https://www.nhl.com/islanders/news/islanders-sign-dravecky?fbclid=PAVERFWAUzO29l", "islanders-sign-dravecky"],
    ["https://nhl.com/news/maple-leafs-acquire-kirill-marchenko", "maple-leafs-acquire-kirill-marchenko"],
    ["https://www.reddit.com/r/hockey/comments/1wz97mu/", undefined],
  ])("reads the slug from %s", (input, slug) => {
    expect(storySlugFromUrl(input)).toBe(slug);
  });

  it("posts a signing the feed's first run skipped, in this server", async () => {
    await replay("https://www.nhl.com/islanders/news/islanders-sign-dravecky?fbclid=PAVERFWAUzO29l");
    await bot.settle();
    expect(sent.map((s) => s.channelId).sort()).toEqual(["isles", "league"]);
    expect(replies[0]?.content).toContain("✅ **Confirmed signing** (New York Islanders) from **NHL.com**.");
  });

  it("says when NHL.com doesn't have the article", async () => {
    await replay("https://www.nhl.com/islanders/news/no-such-story");
    await bot.settle();
    expect(replies[0]?.content).toBe("❌ NHL.com doesn't have an article with that link.");
  });
});
