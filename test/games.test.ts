import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { DAILY_CRON, inDailyWindow, runDailyGames } from "../src/games/daily";
import { ALL_TEAMS, upsertSubscription } from "../src/db/subscriptions";
import type { PostType } from "../src/types";
import { createTestD1 } from "./helpers/d1";
import { createTestBot, requestJson, type TestBot } from "./helpers/discord";
import type { MessageBody } from "../src/discord/api";
import { scheduleResponse } from "./helpers/nhl";

const SATURDAY_MORNING = Date.parse("2026-10-10T15:00:00Z"); // 11 am EDT

let db: D1Database;
let bot: TestBot;
let nhlStatus: number;
let nhlCalls: number;
let sent: { channelId: string; body: MessageBody }[];
let edits: MessageBody[];

beforeEach(async () => {
  db = createTestD1();
  bot = await createTestBot(db);
  nhlStatus = 200;
  nhlCalls = 0;
  sent = [];
  edits = [];
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const schedule = url.match(/api-web\.nhle\.com\/v1\/schedule\/(\d{4}-\d{2}-\d{2})/);
    if (schedule) {
      nhlCalls++;
      return nhlStatus === 200 ? Response.json(scheduleResponse(schedule[1]!)) : new Response("down", { status: nhlStatus });
    }
    if (url.startsWith("https://www.reddit.com/")) return new Response("<feed></feed>");
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

const sub = (channelId: string, teamCode: string, types: PostType[] = ["trade", "waiver", "signing", "games"]) =>
  upsertSubscription(db, { guildId: "g1", channelId, teamCode, types });

describe("daily games post", () => {
  beforeEach(async () => {
    await sub("league", ALL_TEAMS);
    await sub("leafs", "TOR");
    await sub("leafs-news-only", "TOR", ["trade", "waiver", "signing"]);
    await sub("jets", "WPG"); // Winnipeg doesn't play on Oct 10
  });

  it("posts the whole slate to all-teams channels and each team's game to its channels", async () => {
    await runDailyGames(bot.env, SATURDAY_MORNING);

    expect(sent.map((s) => s.channelId).sort()).toEqual(["leafs", "league"]);
    const league = sent.find((s) => s.channelId === "league")!.body.embeds![0]!;
    expect(league.title).toBe("🏒 NHL games · Saturday, Oct 10");
    expect(league.description!.split("\n\n")).toHaveLength(14);

    const leafs = sent.find((s) => s.channelId === "leafs")!.body.embeds![0]!;
    expect(leafs.title).toBe("🏒 Toronto Maple Leafs · Saturday, Oct 10");
    expect(leafs.description).toContain("TOR @ COL");
    expect(leafs.description!.split("\n\n")).toHaveLength(1);
  });

  it("posts each day once, however often it runs", async () => {
    await runDailyGames(bot.env, SATURDAY_MORNING);
    await runDailyGames(bot.env, SATURDAY_MORNING + 2 * 60_000);
    expect(sent).toHaveLength(2);
    expect(nhlCalls).toBe(1);
  });

  it("finishes the remaining channels if a run stopped partway", async () => {
    await db.prepare("INSERT INTO daily_posts (day, channel_id, message_id, posted_at) VALUES ('2026-10-10', 'league', 'm', 0)").run();
    await runDailyGames(bot.env, SATURDAY_MORNING);
    expect(sent.map((s) => s.channelId)).toEqual(["leafs"]);
  });

  it("retries on a later run when the NHL API is down", async () => {
    nhlStatus = 503;
    await expect(runDailyGames(bot.env, SATURDAY_MORNING)).resolves.toBeUndefined();
    expect(sent).toEqual([]);

    nhlStatus = 200;
    await runDailyGames(bot.env, SATURDAY_MORNING + 2 * 60_000);
    expect(sent).toHaveLength(2);
  });

  it("keeps going when one channel can't be posted to", async () => {
    await sub("no-access", ALL_TEAMS);
    await runDailyGames(bot.env, SATURDAY_MORNING);
    expect(sent.map((s) => s.channelId).sort()).toEqual(["leafs", "league"]);
  });

  it("posts nothing on a day without games", async () => {
    await runDailyGames(bot.env, Date.parse("2026-07-20T15:00:00Z"));
    expect(sent).toEqual([]);
  });
});

it("doesn't call the NHL API when no channel wants the schedule", async () => {
  await sub("leafs-news-only", "TOR", ["trade"]);
  await runDailyGames(bot.env, SATURDAY_MORNING);
  expect(nhlCalls).toBe(0);
});

describe("scheduled()", () => {
  const run = (cron: string, time: number) =>
    worker.scheduled({ cron, scheduledTime: time, noRetry() {} } as ScheduledController, bot.env, bot.ctx);

  beforeEach(async () => {
    await sub("league", ALL_TEAMS);
  });

  it("posts the schedule on the daily cron", async () => {
    await run(DAILY_CRON, SATURDAY_MORNING);
    expect(sent.map((s) => s.channelId)).toEqual(["league"]);
  });

  it("retries the daily post from the 2-minute cron during the morning window only", async () => {
    await run("*/2 * * * *", Date.parse("2026-10-10T13:58:00Z"));
    expect(sent).toEqual([]);
    await run("*/2 * * * *", Date.parse("2026-10-10T15:30:00Z"));
    expect(sent).toHaveLength(1);
  });

  it("knows the window", () => {
    expect(inDailyWindow(Date.parse("2026-10-10T14:59:00Z"))).toBe(false);
    expect(inDailyWindow(Date.parse("2026-10-10T15:00:00Z"))).toBe(true);
    expect(inDailyWindow(Date.parse("2026-10-10T17:58:00Z"))).toBe(true);
    expect(inDailyWindow(Date.parse("2026-10-10T18:00:00Z"))).toBe(false);
  });
});

describe("/games", () => {
  const games = async (options: Record<string, string>, guild = true) => {
    const res = await bot.send({
      id: "1",
      application_id: "123",
      token: "tok",
      type: 2,
      ...(guild ? { guild_id: "g1" } : {}),
      channel_id: "c1",
      data: { name: "games", options: Object.entries(options).map(([name, value]) => ({ name, type: 3, value })) },
    });
    return (await res.json()) as { type: number; data?: { flags?: number; content?: string } };
  };

  it("answers publicly, then fills in the day's games", async () => {
    expect(await games({ day: "2026-10-10" })).toEqual({ type: 5 });
    await bot.settle();
    expect(edits[0]?.embeds?.[0]?.title).toBe("🏒 NHL games · Saturday, Oct 10");
    expect(edits[0]?.embeds?.[0]?.description?.split("\n\n")).toHaveLength(14);
  });

  it("narrows to one team", async () => {
    await games({ day: "2026-10-10", team: "Leafs" });
    await bot.settle();
    expect(edits[0]?.embeds?.[0]?.title).toBe("🏒 Toronto Maple Leafs · Saturday, Oct 10");
    expect(edits[0]?.embeds?.[0]?.description).toMatch(/^<t:\d+:t> · \*\*\[TOR @ COL\]/);
  });

  it("shows only one country's channels when asked", async () => {
    await games({ day: "2026-10-10", country: "US" });
    await bot.settle();
    const embed = edits[0]!.embeds![0]!;
    expect(embed.description).toContain("🇺🇸");
    expect(embed.description).not.toContain("🇨🇦");
    expect(embed.description).not.toContain("TVA Sports");
    expect(embed.footer?.text).toContain("US TV");
  });

  it("says when the schedule picks up again in the off-season", async () => {
    await games({ day: "2026-07-20" });
    await bot.settle();
    expect(edits[0]?.embeds?.[0]?.description).toBe("No games. Next games: the week of **Monday, Sep 14**.");
  });

  it("works in DMs too", async () => {
    expect(await games({ day: "2026-10-10" }, false)).toEqual({ type: 5 });
  });

  it("reports when NHL.com is down", async () => {
    nhlStatus = 500;
    await games({ day: "2026-10-10" });
    await bot.settle();
    expect(edits[0]?.content).toContain("couldn't reach NHL.com");
  });

  it("rejects days and teams it doesn't understand", async () => {
    expect((await games({ day: "next friday" })).data?.content).toContain(`I don't understand the day "next friday"`);
    expect((await games({ team: "Nordiques" })).data?.content).toContain(`couldn't find a team called "Nordiques"`);
    expect(edits).toEqual([]);
  });

  it("suggests days and teams", async () => {
    const days = await bot.autocomplete("games", "day", "");
    expect(days).toHaveLength(8);
    expect(days[0]!.name).toMatch(/^Today · /);
    expect(days[1]!.name).toMatch(/^Tomorrow · /);
    expect((await bot.autocomplete("games", "team", "leaf"))[0]).toEqual({ name: "Toronto Maple Leafs", value: "TOR" });
  });
});

describe("/subscribe games option", () => {
  it("is off unless asked for", async () => {
    expect(await bot.command("subscribe", { team: "TOR" })).toContain("**trades, waivers and signings**");
    expect(await bot.command("subscribe", { team: "TOR", games: true })).toContain(
      "**trades, waivers, signings and the daily schedule**",
    );
    expect(
      await bot.command("subscribe", { team: "*", trades: false, waivers: false, signings: false, games: true }),
    ).toBe("✅ This channel will now get **the daily schedule** for **All teams**.");
  });
});
