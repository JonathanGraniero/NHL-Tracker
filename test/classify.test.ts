import { describe, expect, it, vi } from "vitest";
import { classify } from "../src/news/classify";
import type { Headline, ReadHeadline, Reading } from "../src/news/model";

// Real r/hockey titles from August–September 2026. The links are what each
// post pointed at; official team news lives on nhl.com/<team>/. Whether the
// wording means a finished move is Claude's call, measured by `npm run eval`;
// these tests cover what the code decides and how Claude's answer is used.
const NHL = (team: string) => [`https://www.nhl.com/${team}/news/some-release`];
const TWEET = (handle: string) => [`https://xcancel.com/${handle}/status/1?s=20`];

/** A reader that always gives `reading`, and records what it was asked. */
function reader(reading: Reading) {
  return vi.fn<ReadHeadline>(async () => reading);
}
const done = (move: "trade" | "waiver" | "signing", players: string[] = []): Reading => ({ ok: true, move, done: true, players, reason: "reported as done" });

describe("checks made before asking Claude", () => {
  it.each([
    ["[The Athletic] NHL trade grades: Leafs, Blue Jackets make mutually beneficial Knies-Marchenko swap", [], "not from a trusted"],
    ["Matthew Knies was traded by all 3 of his GMs in Toronto", [], "not from a trusted"],
    ["[VAN 5 - EDM (3)] Podkolzin taps it in for his first of the year", [], "not from a trusted"],
    ["[Kaplan] Bill Guerin has signed a multi-year contract extension as GM of the Minnesota Wild, sources told ESPN", [], "not an NHL player move"],
    ["Minnesota Wild Signs Head Coach John Hynes to Multi-Year Contract Extension", NHL("wild"), "not an NHL player move"],
    ["The Chicago Wolves have signed Josiah Slavin to a two-year, one-way AHL contract.", NHL("blackhawks"), "not an NHL player move"],
    ["[Johnston] Notable players on waivers today", [], "no NHL team named"],
  ])("%s", async (title, links, reason) => {
    const read = reader(done("signing"));
    const v = await classify({ title, links }, read);
    expect(v).toMatchObject({ confirmed: false });
    expect(!v.confirmed && v.reason).toContain(reason);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("what Claude is asked", () => {
  it.each<[string, string[], Headline]>([
    ["[Friedman] Gaudet (STL) on waivers", [], { text: "Gaudet (STL) on waivers", source: "Elliotte Friedman", sourceKind: "insider" }],
    ["Leafs acquire forward from Ottawa", TWEET("PierreVLeBrun"), { text: "Leafs acquire forward from Ottawa", source: "Pierre LeBrun", sourceKind: "insider" }],
    ["[Habs] One-year contract for Arber Xhekaj", [], { text: "One-year contract for Arber Xhekaj", source: "Montréal Canadiens", sourceKind: "team account" }],
    ["Canucks claim Leevi Merilainen off waivers from Ottawa", NHL("canucks"), { text: "Canucks claim Leevi Merilainen off waivers from Ottawa", source: "NHL.com", sourceKind: "official site" }],
  ])("%s", async (title, links, headline) => {
    const read = reader(done("waiver"));
    await classify({ title, links }, read);
    expect(read).toHaveBeenCalledWith(headline);
  });
});

describe("using Claude's answer", () => {
  it("posts a finished move with the teams the code found, in order of mention", async () => {
    const title = "[Friedman] Columbus: Knies, Lorentz, Andrae and a 2nd Tor: Marchenko, Miles Wood, Merzlikins (some retained salary)";
    const players = ["Knies", "Lorentz", "Andrae", "Marchenko", "Miles Wood", "Merzlikins"];
    expect(await classify({ title, links: [] }, reader(done("trade", players)))).toEqual({
      confirmed: true,
      type: "trade",
      teams: ["CBJ", "TOR"],
      players,
      source: "Elliotte Friedman",
    });
  });

  it("takes the team from an nhl.com link when the headline names none", async () => {
    const v = await classify({ title: "Islanders Sign Dravecky", links: NHL("islanders") }, reader(done("signing", ["Dravecky"])));
    expect(v).toMatchObject({ confirmed: true, type: "signing", teams: ["NYI"], source: "NHL.com" });
  });

  it("drops player names that aren't in the headline, ignoring case, accents and apostrophes", async () => {
    const title = "MINNESOTA WILD ACQUIRES FORWARD BLAKE COLEMAN AND DEFENSEMAN OLLI MÄÄTTÄ FROM CALGARY 070226";
    const v = await classify({ title, links: NHL("wild") }, reader(done("trade", ["Blake Coleman", "Olli Maatta", "Connor McDavid", " "])));
    expect(v.confirmed && v.players).toEqual(["Blake Coleman", "Olli Maatta"]);

    const v2 = await classify({ title: "[Friedman] Leafs acquire Ryan O’Reilly from Nashville", links: [] }, reader(done("trade", ["Ryan O'Reilly"])));
    expect(v2.confirmed && v2.players).toEqual(["Ryan O'Reilly"]);
  });

  it("skips a move that isn't done, with Claude's reason", async () => {
    const title = "[LeBrun] The proposed Leafs-Blue Jackets trade involves multiple pieces, including Knies and Marchenko, and it's not a done deal yet.";
    const v = await classify({ title, links: [] }, reader({ ok: true, move: "trade", done: false, players: [], reason: "says it's not a done deal" }));
    expect(v).toEqual({ confirmed: false, reason: "not confirmed yet (says it's not a done deal)" });
  });

  it("skips what isn't a trade, waiver or signing", async () => {
    const v = await classify(
      { title: "Jacob Fowler recalled from Laval Rocket", links: NHL("canadiens") },
      reader({ ok: true, move: "none", done: true, players: [], reason: "a recall" }),
    );
    expect(v).toEqual({ confirmed: false, reason: "not a trade, waiver or signing (a recall)" });
  });

  it("marks the post for another try when Claude can't be reached", async () => {
    const v = await classify({ title: "[Friedman] Gaudet (STL) on waivers", links: [] }, reader({ ok: false, unavailable: true, reason: "Claude API 529" }));
    expect(v).toEqual({ confirmed: false, reason: "Claude API 529", unavailable: true });
  });

  it("skips the post when Claude's answer can't be used", async () => {
    const v = await classify({ title: "[Friedman] Gaudet (STL) on waivers", links: [] }, reader({ ok: false, unavailable: false, reason: "Claude declined to read this headline" }));
    expect(v).toEqual({ confirmed: false, reason: "Claude declined to read this headline" });
  });
});
