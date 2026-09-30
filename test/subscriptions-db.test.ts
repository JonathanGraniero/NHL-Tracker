import { beforeEach, describe, expect, it } from "vitest";
import {
  ALL_TEAMS,
  clearChannel,
  findChannelsFor,
  listForChannel,
  removeSubscription,
  upsertSubscription,
} from "../src/db/subscriptions";
import { createTestD1 } from "./helpers/d1";

let db: D1Database;
const all = ["trade", "waiver", "signing"] as const;

beforeEach(() => {
  db = createTestD1();
});

const sub = (channelId: string, teamCode: string, types: readonly ("trade" | "waiver" | "signing")[] = all) =>
  upsertSubscription(db, { guildId: "g", channelId, teamCode, types });

describe("subscriptions table", () => {
  it("creates, then updates instead of duplicating", async () => {
    expect(await sub("c1", "TOR")).toBe("created");
    expect(await sub("c1", "TOR", ["trade"])).toBe("updated");
    expect(await listForChannel(db, "c1")).toEqual([{ teamCode: "TOR", types: ["trade"] }]);
  });

  it("keeps channels separate", async () => {
    await sub("c1", "TOR");
    await sub("c2", "MTL");
    expect((await listForChannel(db, "c1")).map((s) => s.teamCode)).toEqual(["TOR"]);
    expect((await listForChannel(db, "c2")).map((s) => s.teamCode)).toEqual(["MTL"]);
  });

  it("removes one subscription and reports whether it existed", async () => {
    await sub("c1", "TOR");
    expect(await removeSubscription(db, "c1", "TOR")).toBe(true);
    expect(await removeSubscription(db, "c1", "TOR")).toBe(false);
  });

  it("clears a whole channel without touching others", async () => {
    await sub("c1", "TOR");
    await sub("c1", "MTL");
    await sub("c2", "TOR");
    expect(await clearChannel(db, "c1")).toBe(2);
    expect(await listForChannel(db, "c1")).toEqual([]);
    expect(await listForChannel(db, "c2")).toHaveLength(1);
  });
});

describe("findChannelsFor (who gets a post)", () => {
  beforeEach(async () => {
    await sub("leafs", "TOR");
    await sub("habs-trades", "MTL", ["trade"]);
    await sub("everything", ALL_TEAMS);
    await sub("league-signings", ALL_TEAMS, ["signing"]);
  });

  it("matches either team in a trade, plus all-teams channels", async () => {
    const channels = await findChannelsFor(db, ["TOR", "MTL"], "trade");
    expect(channels.sort()).toEqual(["everything", "habs-trades", "leafs"]);
  });

  it("respects the channel's type filter", async () => {
    expect((await findChannelsFor(db, ["MTL"], "waiver")).sort()).toEqual(["everything"]);
    expect((await findChannelsFor(db, ["MTL"], "signing")).sort()).toEqual(["everything", "league-signings"]);
  });

  it("returns each channel once even if it follows both teams", async () => {
    await sub("leafs", "MTL");
    const channels = await findChannelsFor(db, ["TOR", "MTL"], "trade");
    expect(channels.filter((c) => c === "leafs")).toHaveLength(1);
  });

  it("returns nobody for an unfollowed team when there are no all-teams channels", async () => {
    await clearChannel(db, "everything");
    await clearChannel(db, "league-signings");
    expect(await findChannelsFor(db, ["SEA"], "trade")).toEqual([]);
  });
});
