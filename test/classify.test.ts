import { describe, expect, it } from "vitest";
import { classify } from "../src/news/classify";

// Real r/hockey titles from August–September 2026. The links are what each
// post pointed at; official team news lives on nhl.com/<team>/.
const NHL = (team: string) => [`https://www.nhl.com/${team}/news/some-release`];
const TWEET = (handle: string) => [`https://xcancel.com/${handle}/status/1?s=20`];

describe("confirmed moves", () => {
  it.each([
    // The Knies–Marchenko trade, as Friedman reported it once it was done.
    ["[Friedman] Columbus: Knies, Lorentz, Andrae and a 2nd Tor: Marchenko, Miles Wood, Merzlikins (some retained salary)", [], "trade", ["CBJ", "TOR"], "Elliotte Friedman"],
    ["The New Jersey Devils announced today that the team has acquired forward Luke Evangelista in a trade with Nashville in exchange for Colorado’s 2028 first-round pick (conditional) and New Jersey’s 2028 second-round pick", NHL("devils"), "trade", ["NJD", "NSH"], "NHL.com"],
    ["Canucks claim Leevi Merilainen off waivers from Ottawa", NHL("canucks"), "waiver", ["VAN", "OTT"], "NHL.com"],
    ["[Johnston] The Leafs are placing Steven Lorentz on waivers this afternoon.", [], "waiver", ["TOR"], "Chris Johnston"],
    ["[Friedman] Gaudet (STL) on waivers", [], "waiver", ["STL"], "Elliotte Friedman"],
    ["[Vegas Golden Knights] William Karlsson extended 2 X 6.75M", [], "signing", ["VGK"], "Vegas Golden Knights"],
    ["[Montreal Canadiens] Four-year contract extension for Alex Newhook (5.5M AAV)", [], "signing", ["MTL"], "Montréal Canadiens"],
    ["[Kaplan] Cale Makar has agreed to an eight year extension with the Colorado Avalanche. $20.4 million AAV. He will be the highest paid player in NHL history.", [], "signing", ["COL"], "Emily Kaplan"],
    ["Dallas Stars sign Goaltender Casey DeSmith to a two-year, $5 million contract extension (2x$2.5m AAV)", NHL("stars"), "signing", ["DAL"], "NHL.com"],
    ["We have signed Noah Ostlund to an eight-year contract extension with an AAV of $6.6 million.", NHL("sabres"), "signing", ["BUF"], "NHL.com"],
    ["Leafs acquire forward from Ottawa", TWEET("PierreVLeBrun"), "trade", ["TOR", "OTT"], "Pierre LeBrun"],
    // Present tense, but with the exact terms it's a done deal (missed on 2026-10-01).
    ["[Friedman] Anaheim is extending young D Tristan Luneau 6 x $7.2M AAV", [], "signing", ["ANA"], "Elliotte Friedman"],
    ["[Johnston] The Rangers are re-signing Adam Edstrom to a 2-year, $1.8M deal", [], "signing", ["NYR"], "Chris Johnston"],
    // "Deal agreed", "bringing in", and terms announced with a name but no verb (missed on 2026-10-06).
    ["[Dreger] The Flyers are bringing in Michael Bunting for some spark. Deal agreed to at $1.2 mil. AAV.", [], "signing", ["PHI"], "Darren Dreger"],
    ["[Habs] One-year contract for Arber Xhekaj", [], "signing", ["MTL"], "Montréal Canadiens"],
    ["One-year contract for Kirby Dach | Montréal Canadiens", NHL("canadiens"), "signing", ["MTL"], "NHL.com"],
    ["[Pierre LeBrun] 8 x 10.75M AAV for Drake Batherson in Ottawa. Major business done by the Senators.", [], "signing", ["OTT"], "Pierre LeBrun"],
  ])("%s", (title, links, type, teams, source) => {
    expect(classify({ title, links })).toMatchObject({ confirmed: true, type, teams, source });
  });

  it("names the players in a trade", () => {
    const v = classify({ title: "[Friedman] Columbus: Knies, Lorentz, Andrae and a 2nd Tor: Marchenko, Miles Wood, Merzlikins (some retained salary)", links: [] });
    expect(v.confirmed && v.players).toEqual(["Knies", "Lorentz", "Andrae", "Marchenko", "Miles Wood", "Merzlikins"]);
  });
});

describe("not posted", () => {
  it.each([
    // Earlier reports of the same trade, before it was done.
    ["[LeBrun] The proposed Leafs-Blue Jackets trade involves multiple pieces, including Knies and Marchenko, and it's not a done deal yet.", [], "not confirmed yet"],
    ["[Friedman] Okay, sorry for the delay. I believe the math forced Toronto/Columbus to rework the trade Still involves Marchenko, Knies & Merzlikins", [], "not confirmed yet"],
    ["[Friedman] It sounds like Columbus gave Toronto permission to speak to Marchenko about an extension.", [], "not confirmed yet"],
    // Commentary and fan posts about it.
    ["[The Athletic] NHL trade grades: Leafs, Blue Jackets make mutually beneficial Knies-Marchenko swap", [], "not from a trusted"],
    ["Matthew Knies was traded by all 3 of his GMs in Toronto", [], "not from a trusted"],
    ["[LeBrun] A little sidenote to the blockbuster trade from yesterday, Toronto was on Elvis Merzlikins' no-move list", [], "no completed"],
    // Other speculation.
    ["[Kaplan]: The Vegas Golden Knights are closing in on a contract extension with William Karlsson, sources told ESPN.", [], "not confirmed yet"],
    ["[Friedman] Sources: Senators nearing eight-year contract extension with Drake Batherson", [], "not confirmed yet"],
    ["[Friedman] Ducks, Kreider expected to agree to waivers for contract termination", [], "not confirmed yet"],
    // Present tense without terms can still mean talks.
    ["[Friedman] Anaheim is extending young D Tristan Luneau", [], "no completed"],
    ["[Dreger] The Flyers are bringing in Michael Bunting for some spark.", [], "no completed"],
    // Terms alone, or terms "for" something that isn't a player, aren't a signing.
    ["[Friedman] Kreider AAV is $2.15M Bonuses can bring up to $3M more.", [], "no completed"],
    ["[Seravalli] NHL teams doled out $204.4 million in signing bonuses for the 2027-28 season", [], "no completed"],
    // Hedged versions stay out.
    ["[LeBrun] Hearing the Blue Jackets will be signing UFA veteran goalie Cam Talbot, 39, to a one-year deal ($950k)", [], "not confirmed yet"],
    ["[Friedman] A one-year contract for Bunting would make sense for the Flyers", [], "not confirmed yet"],
    ["[32 Thoughts] Potential three-way trade involving Nikishin and Hellebuyck?", [], "not from a trusted"],
    // Not player moves, or not NHL.
    ["[Kaplan] Bill Guerin has signed a multi-year contract extension as GM of the Minnesota Wild, sources told ESPN", [], "not an NHL player move"],
    ["Minnesota Wild Signs Head Coach John Hynes to Multi-Year Contract Extension", NHL("wild"), "not an NHL player move"],
    ["The Chicago Wolves have signed Josiah Slavin to a two-year, one-way AHL contract.", NHL("blackhawks"), "not an NHL player move"],
    // Lists with no team, and game highlights.
    ["[Johnston] Notable players on waivers today", [], "no NHL team named"],
    ["[VAN 5 - EDM (3)] Podkolzin taps it in for his first of the year", [], "not from a trusted"],
    ["Post Game Thread: Montréal Canadiens @ Toronto Maple Leafs", NHL("mapleleafs"), "no completed"],
  ])("%s", (title, links, reason) => {
    const v = classify({ title, links });
    expect(v.confirmed).toBe(false);
    expect(!v.confirmed && v.reason).toContain(reason);
  });
});
