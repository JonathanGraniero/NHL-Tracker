import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFeed, postIdFromInput } from "../src/sources/reddit";

// A real r/hockey search feed for "Knies" from the week of the Knies-Marchenko trade.
const KNIES_FEED = readFileSync(join(import.meta.dirname, "fixtures/knies-search.xml"), "utf8");

describe("parseFeed", () => {
  const items = parseFeed(KNIES_FEED);
  const friedman = items.find((i) => i.id === "t3_1wsqy36");

  it("reads every post in the feed", () => {
    expect(items.length).toBeGreaterThanOrEqual(10);
    expect(items.every((i) => i.id.startsWith("t3_") && i.url.startsWith("https://www.reddit.com/r/hockey/"))).toBe(true);
  });

  it("decodes the title, permalink and publish time", () => {
    expect(friedman).toMatchObject({
      source: "reddit",
      title: "[Friedman] Columbus: Knies, Lorentz, Andrae and a 2nd Tor: Marchenko, Miles Wood, Merzlikins (some retained salary)",
      url: "https://www.reddit.com/r/hockey/comments/1wsqy36/friedman_columbus_knies_lorentz_andrae_and_a_2nd/",
      publishedAt: Date.parse("2026-09-28T21:07:00+00:00"),
    });
  });

  it("keeps outside links (the tweet) and drops Reddit's own", () => {
    expect(friedman?.links).toContain("https://xcancel.com/FriedgeHNIC/status/2104679097859448993?s=20");
    expect(friedman?.links.some((l) => /redd\.?it/.test(l))).toBe(false);
  });

  it("decodes entities in titles", () => {
    expect(items.some((i) => i.title.includes("’") || i.title.includes("&"))).toBe(true);
    expect(items.some((i) => /&(amp|quot|#\d+);/.test(i.title))).toBe(false);
  });
});

describe("postIdFromInput", () => {
  it.each([
    ["https://www.reddit.com/r/hockey/comments/1wsqy36/friedman_columbus_knies/", "t3_1wsqy36"],
    ["https://old.reddit.com/r/hockey/comments/1WSQY36/", "t3_1wsqy36"],
    ["https://redd.it/1wsqy36", "t3_1wsqy36"],
    ["t3_1wsqy36", "t3_1wsqy36"],
    ["1wsqy36", "t3_1wsqy36"],
  ])("%s → %s", (input, id) => {
    expect(postIdFromInput(input)).toBe(id);
  });

  it("rejects things that aren't posts", () => {
    expect(postIdFromInput("https://www.reddit.com/r/hockey/")).toBeUndefined();
    expect(postIdFromInput("the knies trade")).toBeUndefined();
  });
});
