import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { INJURY_CRON, runInjuryCheck } from "../src/injuries/tracker";
import { observe } from "../src/injuries/episodes";
import { Budget, deliver } from "../src/injuries/deliver";
import { openEpisodes } from "../src/db/injuries";
import { ALL_TEAMS, upsertSubscription } from "../src/db/subscriptions";
import type { MessageBody } from "../src/discord/api";
import type { EspnInjuriesResponse, EspnInjury } from "../src/sources/espn-injuries";
import type { PostType } from "../src/types";
import { createTestD1 } from "./helpers/d1";
import { createTestBot, requestJson, type TestBot } from "./helpers/discord";
import { ESPN_FIXTURE, espnEntry, espnResponse } from "./helpers/espn";

const T0 = Date.parse("2026-10-02T15:00:00Z");
const MIN = 60_000;

let db: D1Database;
let bot: TestBot;
let espn: EspnInjuriesResponse;
let espnStatus: number;
let sent: { channelId: string; body: MessageBody; id: string }[];
let edited: { channelId: string; messageId: string; body: MessageBody }[];

beforeEach(async () => {
  db = createTestD1();
  bot = await createTestBot(db);
  espn = espnResponse([]);
  espnStatus = 200;
  sent = [];
  edited = [];
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://site.api.espn.com/")) {
      return espnStatus === 200 ? Response.json(espn) : new Response("down", { status: espnStatus });
    }
    if (url.startsWith("https://www.reddit.com/")) return new Response("<feed></feed>");
    const edit = url.match(/discord\.com\/api\/v10\/channels\/([^/]+)\/messages\/([^/]+)$/);
    if (edit && init?.method === "PATCH") {
      edited.push({ channelId: edit[1]!, messageId: edit[2]!, body: requestJson<MessageBody>(init) });
      return Response.json({ id: edit[2] });
    }
    const post = url.match(/discord\.com\/api\/v10\/channels\/([^/]+)\/messages$/);
    if (post) {
      if (post[1] === "no-access") return new Response('{"message":"Missing Access"}', { status: 403 });
      const id = `msg-${sent.length + 1}`;
      sent.push({ channelId: post[1]!, body: requestJson<MessageBody>(init), id });
      return Response.json({ id });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const sub = (channelId: string, teamCode: string, types: PostType[]) =>
    upsertSubscription(db, { guildId: "g1", channelId, teamCode, types });
  await sub("leafs", "TOR", ["trade", "injuries"]);
  await sub("league", ALL_TEAMS, ["trade", "injuries"]);
  await sub("leafs-news-only", "TOR", ["trade", "waiver", "signing"]);
  await sub("habs", "MTL", ["injuries"]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Runs a check with ESPN listing `entries` (plus steady background injuries). */
async function check(entries: EspnInjury[], at: number) {
  espn = espnResponse(entries);
  await runInjuryCheck(bot.env, at);
}

const titles = () => sent.map((s) => `${s.channelId}: ${s.body.embeds?.[0]?.title}`);
const matthews = (status: "DD" | "O" | "IR", over: { returnDate?: string; note?: string } = {}) =>
  espnEntry({ player: "Auston Matthews", team: "TOR", status, ...over });

/** First run records the league quietly; tests start from there. */
async function baseline(entries: EspnInjury[] = []) {
  await check(entries, T0);
  expect(sent).toEqual([]);
}

describe("first run", () => {
  it("records the real league list without posting anything", async () => {
    espn = ESPN_FIXTURE;
    await runInjuryCheck(bot.env, T0);
    expect(sent).toEqual([]);
    expect(await openEpisodes(db)).toHaveLength(108);
    expect((await openEpisodes(db, ["ANA"])).map((e) => e.player)).toContain("A.J. Greer");
  });
});

describe("ESPN changes", () => {
  it("posts a new IR injury to channels following the team or all teams, for injuries only", async () => {
    await baseline();
    await check([matthews("IR", { note: "Matthews (lower body) was placed on IR, per Chris Johnston." })], T0 + 10 * MIN);
    expect(titles().sort()).toEqual([
      "leafs: 🩹 Auston Matthews (C) · Toronto Maple Leafs",
      "league: 🩹 Auston Matthews (C) · Toronto Maple Leafs",
    ]);
    const description = sent[0]!.body.embeds![0]!.description!;
    expect(description).toContain("**Injured reserve** · lower body · est. return Oct 20");
    expect(description).toContain("> Matthews (lower body) was placed on IR, per Chris Johnston.");
    expect(description).toContain("via ESPN");
  });

  it("doesn't post day-to-day, then posts when it becomes serious", async () => {
    await baseline();
    await check([matthews("DD")], T0 + 10 * MIN);
    expect(sent).toEqual([]);
    expect((await openEpisodes(db, ["TOR"]))[0]?.status).toBe("day-to-day");

    await check([matthews("O")], T0 + 20 * MIN);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body.message_reference).toBeUndefined();
  });

  it("replies to the original post when it gets worse, and edits the original", async () => {
    await baseline();
    await check([matthews("O")], T0 + 10 * MIN);
    const originals = new Map(sent.map((s) => [s.channelId, s.id]));

    await check([matthews("IR")], T0 + 20 * MIN);
    const replies = sent.slice(2);
    expect(replies).toHaveLength(2);
    for (const r of replies) {
      expect(r.body.embeds![0]!.title).toBe("📈 Auston Matthews (C) · Toronto Maple Leafs");
      expect(r.body.embeds![0]!.description).toMatch(/^Out → \*\*Injured reserve\*\*/);
      expect(r.body.message_reference?.message_id).toBe(originals.get(r.channelId));
    }
    expect(edited.map((e) => e.messageId).sort()).toEqual([...originals.values()].sort());
    expect(edited[0]!.body.embeds![0]!.description).toContain("**Injured reserve**");
  });

  it("only edits when the estimated return moves", async () => {
    await baseline();
    await check([matthews("IR")], T0 + 10 * MIN);
    await check([matthews("IR", { returnDate: "2026-11-15" })], T0 + 20 * MIN);
    expect(sent).toHaveLength(2);
    expect(edited).toHaveLength(2);
    expect(edited[0]!.body.embeds![0]!.description).toContain("est. return Nov 15");
  });

  it("ignores changes to ESPN's note text alone", async () => {
    await baseline();
    await check([matthews("IR")], T0 + 10 * MIN);
    await check([matthews("IR", { note: "Matthews skated on his own Thursday." })], T0 + 20 * MIN);
    expect(sent).toHaveLength(2);
    expect(edited).toEqual([]);
  });

  it("posts a return only after two checks in a row without him, as a reply", async () => {
    await baseline();
    await check([matthews("IR")], T0 + 10 * MIN);
    await check([], T0 + 20 * MIN);
    expect(sent).toHaveLength(2);

    await check([], T0 + 30 * MIN);
    const back = sent.slice(2);
    expect(back.map((s) => s.body.embeds![0]!.title)).toEqual([
      "✅ Auston Matthews (C) is off the injury list · Toronto Maple Leafs",
      "✅ Auston Matthews (C) is off the injury list · Toronto Maple Leafs",
    ]);
    expect(back.every((s) => s.body.message_reference)).toBe(true);
    expect(await openEpisodes(db, ["TOR"])).toEqual([]);
  });

  it("doesn't count a single missed check as a return", async () => {
    await baseline();
    await check([matthews("IR")], T0 + 10 * MIN);
    await check([], T0 + 20 * MIN);
    await check([matthews("IR")], T0 + 30 * MIN);
    await check([], T0 + 40 * MIN);
    expect(sent).toHaveLength(2);
  });

  it("starts a new episode, and a new post, if he's hurt again after returning", async () => {
    await baseline();
    await check([matthews("IR")], T0 + 10 * MIN);
    await check([], T0 + 20 * MIN);
    await check([], T0 + 30 * MIN);
    await check([matthews("O")], T0 + 40 * MIN);
    const last = sent.at(-1)!;
    expect(last.body.embeds![0]!.title).toBe("🩹 Auston Matthews (C) · Toronto Maple Leafs");
    expect(last.body.message_reference).toBeUndefined();
  });

  it("closes a day-to-day episode quietly", async () => {
    await baseline();
    await check([matthews("DD")], T0 + 10 * MIN);
    await check([], T0 + 20 * MIN);
    await check([], T0 + 30 * MIN);
    expect(sent).toEqual([]);
    expect(await openEpisodes(db, ["TOR"])).toEqual([]);
  });

  it("labels suspensions", async () => {
    await baseline();
    await check([espnEntry({ player: "Josh Anderson", team: "MTL", status: "SUSP" })], T0 + 10 * MIN);
    expect(titles()).toContain("habs: ⚖️ Josh Anderson (C) · Montréal Canadiens");
    expect(sent[0]!.body.embeds![0]!.description).toMatch(/^\*\*Suspended\*\*/);
  });
});

describe("safety", () => {
  it("skips a check where most of the league vanished", async () => {
    await baseline([matthews("IR")]);
    espn = { injuries: [{ displayName: "TOR", injuries: [] }] };
    await runInjuryCheck(bot.env, T0 + 10 * MIN);
    await runInjuryCheck(bot.env, T0 + 20 * MIN);
    expect(sent).toEqual([]);
    expect(await openEpisodes(db, ["TOR"])).toHaveLength(1);
  });

  it("waits for the next run when ESPN is down", async () => {
    await baseline();
    espnStatus = 503;
    await expect(check([matthews("IR")], T0 + 10 * MIN)).resolves.toBeUndefined();
    expect(sent).toEqual([]);
    espnStatus = 200;
    await check([matthews("IR")], T0 + 20 * MIN);
    expect(sent).toHaveLength(2);
  });

  it("keeps going when one channel can't be posted to", async () => {
    await upsertSubscription(db, { guildId: "g1", channelId: "no-access", teamCode: "TOR", types: ["injuries"] });
    await baseline();
    await check([matthews("IR")], T0 + 10 * MIN);
    expect(sent.map((s) => s.channelId).sort()).toEqual(["leafs", "league"]);
  });

  it("stays within the Discord budget and finishes on the next run without repeats", async () => {
    for (let i = 0; i < 45; i++) {
      await upsertSubscription(db, { guildId: "g2", channelId: `fan-${i}`, teamCode: "TOR", types: ["injuries"] });
    }
    await baseline();
    await check([matthews("IR")], T0 + 10 * MIN);
    expect(sent).toHaveLength(40);

    await check([matthews("IR")], T0 + 20 * MIN);
    expect(sent).toHaveLength(47); // 45 fans + leafs + league
    expect(new Set(sent.map((s) => s.channelId)).size).toBe(47);
  });

  it("finishes an update an earlier run recorded but never sent", async () => {
    await baseline();
    const [effect] = await observe(db, {
      team: "TOR",
      playerKey: "auston matthews",
      player: "Auston Matthews",
      status: "ir",
      source: "espn",
      at: T0 + 5 * MIN,
    });
    expect(effect?.kind).toBe("post");
    // (the run "crashed" here, before delivering)
    await check([], T0 + 10 * MIN);
    expect(sent.map((s) => s.channelId).sort()).toEqual(["leafs", "league"]);
  });

  it("never sends an update to the same channel twice", async () => {
    await baseline();
    const [effect] = await observe(db, { team: "TOR", playerKey: "x y", player: "X Y", status: "out", source: "espn", at: T0 });
    await deliver(bot.env, [effect!], T0, new Budget(40));
    await deliver(bot.env, [effect!], T0, new Budget(40));
    expect(sent).toHaveLength(2);
  });
});

describe("reports from more than one source", () => {
  const reddit = (over: Partial<Parameters<typeof observe>[1]> = {}) =>
    observe(db, {
      team: "TOR",
      playerKey: "auston matthews",
      player: "Auston Matthews",
      status: "ir",
      source: "reddit",
      reporter: "Chris Johnston",
      threadUrl: "https://www.reddit.com/r/hockey/comments/abc/",
      at: T0 + 5 * MIN,
      ...over,
    });

  it("posts once when r/hockey breaks it, then edits the post when ESPN confirms", async () => {
    await baseline();
    await deliver(bot.env, await reddit(), T0 + 5 * MIN, new Budget(40));
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body.embeds![0]!.description).toContain("First reported by **Chris Johnston** · [r/hockey]");

    await check([matthews("IR")], T0 + 10 * MIN);
    expect(sent).toHaveLength(2);
    expect(edited).toHaveLength(2);
    expect(edited[0]!.body.embeds![0]!.description).toContain("✓ confirmed by ESPN");
  });

  it("stays quiet when a second r/hockey report arrives for the same injury", async () => {
    await baseline();
    await deliver(bot.env, await reddit(), T0 + 5 * MIN, new Budget(40));
    await deliver(bot.env, await reddit({ reporter: "Luke Fox", at: T0 + 7 * MIN }), T0 + 7 * MIN, new Budget(40));
    expect(sent).toHaveLength(2);
    expect(edited).toEqual([]);
  });

  it("lets r/hockey raise the status but never lower ESPN's", async () => {
    await baseline();
    await check([matthews("O")], T0 + 10 * MIN);
    // ESPN broke it, so the r/hockey thread and reporter get added to the post (an edit), but "day-to-day" doesn't lower it.
    const lower = await reddit({ status: "day-to-day", at: T0 + 12 * MIN });
    expect(lower.map((e) => e.kind)).toEqual(["edit"]);
    expect((await openEpisodes(db, ["TOR"]))[0]?.status).toBe("out");

    const effects = await reddit({ status: "ir", at: T0 + 14 * MIN });
    expect(effects.map((e) => (e.kind === "post" ? e.update.kind : e.kind))).toEqual(["update", "edit"]);
  });
});

describe("/injuries and /subscribe", () => {
  it("lists the injury list for a team, publicly", async () => {
    await baseline([matthews("IR"), espnEntry({ player: "William Nylander", team: "TOR", status: "DD", body: "Groin" })]);
    const res = await bot.send({ id: "1", type: 2, guild_id: "g1", channel_id: "c", data: { name: "injuries", options: [{ name: "team", type: 3, value: "Leafs" }] } });
    const json = (await res.json()) as { type: number; data: MessageBody & { flags?: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBeUndefined();
    expect(json.data.embeds![0]!.title).toBe("🩹 Injuries · Toronto Maple Leafs");
    expect(json.data.embeds![0]!.description!.split("\n")).toEqual([
      "• Auston Matthews (C): Injured reserve · lower body · est. return Oct 20",
      "• William Nylander (C): Day-to-day · groin · est. return Oct 20",
    ]);
  });

  it("lists the whole league grouped by team, within Discord's limit", async () => {
    espn = ESPN_FIXTURE;
    await runInjuryCheck(bot.env, T0);
    const res = await bot.send({ id: "1", type: 2, channel_id: "c", data: { name: "injuries" } });
    const description = ((await res.json()) as { data: MessageBody }).data.embeds![0]!.description!;
    expect(description.length).toBeLessThanOrEqual(4096);
    expect(description).toMatch(/^\*\*Anaheim Ducks\*\*\n• /);
    expect(description).toMatch(/…and \d+ more\. Add `team:` to see one team\.$/);
  });

  it("says when a team has nobody hurt", async () => {
    await baseline();
    const res = await bot.send({ id: "1", type: 2, channel_id: "c", data: { name: "injuries", options: [{ name: "team", type: 3, value: "BOS" }] } });
    expect(((await res.json()) as { data: MessageBody }).data.embeds![0]!.description).toBe("Nobody on the injury list. 🎉");
  });

  it("subscribes to injuries only when asked", async () => {
    expect(await bot.command("subscribe", { team: "BOS" })).toContain("**trades, waivers and signings**");
    expect(await bot.command("subscribe", { team: "BOS", injuries: true })).toContain("**trades, waivers, signings and injuries**");
  });

  it("autocompletes teams", async () => {
    expect((await bot.autocomplete("injuries", "team", "leaf"))[0]).toEqual({ name: "Toronto Maple Leafs", value: "TOR" });
  });
});

it("runs the injury check on its cron", async () => {
  await worker.scheduled({ cron: INJURY_CRON, scheduledTime: T0, noRetry() {} } as ScheduledController, bot.env, bot.ctx);
  expect(await db.prepare("SELECT value FROM bot_state WHERE key = 'injuries_ready'").first("value")).toBe(String(T0));
});
