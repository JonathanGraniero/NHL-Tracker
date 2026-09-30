import { beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../src/discord/commands";
import { createTestD1 } from "./helpers/d1";
import { createTestBot, type TestBot } from "./helpers/discord";

let bot: TestBot;

beforeEach(async () => {
  bot = await createTestBot(createTestD1());
});

describe("/subscribe", () => {
  it("subscribes to all types by default", async () => {
    const msg = await bot.command("subscribe", { team: "TOR" });
    expect(msg).toBe("✅ This channel will now get **trades, waivers and signings** for **Toronto Maple Leafs**.");
  });

  it("accepts a typed nickname instead of an autocomplete pick", async () => {
    expect(await bot.command("subscribe", { team: "habs" })).toContain("Montréal Canadiens");
  });

  it("filters types and updates an existing subscription", async () => {
    await bot.command("subscribe", { team: "TOR" });
    const msg = await bot.command("subscribe", { team: "TOR", waivers: false, signings: false });
    expect(msg).toBe("✅ This channel now gets **trades** for **Toronto Maple Leafs**.");
  });

  it("supports all teams", async () => {
    expect(await bot.command("subscribe", { team: "*" })).toContain("**All teams**");
  });

  it("accepts \"all\" typed by hand", async () => {
    expect(await bot.command("subscribe", { team: "All Teams" })).toContain("**All teams**");
    expect(await bot.command("unsubscribe", { team: "all" })).toContain("no longer get news for **All teams**");
  });

  it("rejects an unknown team", async () => {
    expect(await bot.command("subscribe", { team: "Quebec Nordiques" })).toContain("couldn't find a team");
  });

  it("rejects turning every type off", async () => {
    const msg = await bot.command("subscribe", { team: "TOR", trades: false, waivers: false, signings: false });
    expect(msg).toContain("at least one");
  });

  it("refuses to run outside a server", async () => {
    expect(await bot.command("subscribe", { team: "TOR" }, { guildId: null })).toContain("only works in a server");
  });
});

describe("/subscriptions", () => {
  it("explains how to start when empty", async () => {
    expect(await bot.command("subscriptions")).toContain("isn't following any teams");
  });

  it("lists all-teams first, then teams alphabetically, for this channel only", async () => {
    await bot.command("subscribe", { team: "TOR", signings: false });
    await bot.command("subscribe", { team: "ANA" });
    await bot.command("subscribe", { team: "*", trades: false, waivers: false });
    await bot.command("subscribe", { team: "MTL" }, { channelId: "other-channel" });

    expect(await bot.command("subscriptions")).toBe(
      [
        "**This channel follows:**",
        "• **All teams**: signings",
        "• **Anaheim Ducks**: trades, waivers and signings",
        "• **Toronto Maple Leafs**: trades and waivers",
      ].join("\n"),
    );
  });
});

describe("/unsubscribe", () => {
  it("removes a team", async () => {
    await bot.command("subscribe", { team: "TOR" });
    expect(await bot.command("unsubscribe", { team: "TOR" })).toContain("no longer get news for **Toronto Maple Leafs**");
    expect(await bot.command("subscriptions")).toContain("isn't following any teams");
  });

  it("says so when the channel wasn't following the team", async () => {
    expect(await bot.command("unsubscribe", { team: "TOR" })).toContain("wasn't following");
  });

  it("can clear the whole channel", async () => {
    await bot.command("subscribe", { team: "TOR" });
    await bot.command("subscribe", { team: "MTL" });
    expect(await bot.command("unsubscribe", { team: "__clear__" })).toBe("✅ Removed all 2 subscriptions from this channel.");
  });
});

describe("autocomplete", () => {
  it("offers All teams plus every team when nothing is typed, within Discord's 25 limit", async () => {
    const choices = await bot.autocomplete("subscribe", "team", "");
    expect(choices[0]).toEqual({ name: "⭐ All teams", value: "*" });
    expect(choices).toHaveLength(25);
  });

  it("finds teams by nickname and city", async () => {
    expect((await bot.autocomplete("subscribe", "team", "leaf")).map((c) => c.value)).toEqual(["TOR"]);
    expect((await bot.autocomplete("subscribe", "team", "new")).map((c) => c.value)).toEqual(["NJD", "NYI", "NYR"]);
  });

  it("only offers this channel's teams when unsubscribing", async () => {
    await bot.command("subscribe", { team: "TOR" });
    await bot.command("subscribe", { team: "MTL" });
    await bot.command("subscribe", { team: "BOS" }, { channelId: "other-channel" });
    const values = (await bot.autocomplete("unsubscribe", "team", "")).map((c) => c.value);
    expect(values).toEqual(["MTL", "TOR", "__clear__"]);
  });
});

describe("command definitions", () => {
  it("restricts changing subscriptions to Manage Server by default", () => {
    for (const name of ["subscribe", "unsubscribe"]) {
      const cmd = COMMANDS.find((c) => c.name === name) as { default_member_permissions?: string };
      expect(cmd.default_member_permissions).toBe("32");
    }
  });
});
