import { describe, expect, it } from "vitest";
import { parseInjuries, playerKey } from "../src/sources/espn-injuries";
import { diffInjuries } from "../src/injuries/diff";
import type { SnapshotRow } from "../src/db/injuries";
import { ESPN_FIXTURE, espnEntry } from "./helpers/espn";

describe("parseInjuries", () => {
  const reports = parseInjuries(ESPN_FIXTURE);

  it("reads every injury and suspension, skipping absences that aren't injuries", () => {
    expect(reports).toHaveLength(108); // 111 listed: two contract disputes and one "not injury related"
    expect(reports.find((r) => r.player === "Alexander Nikishin")).toBeUndefined();
    expect(reports.filter((r) => r.status === "suspended")).toHaveLength(2);
  });

  it("maps ESPN's team abbreviations to ours", () => {
    const teams = new Set(reports.map((r) => r.team));
    for (const code of ["LAK", "NJD", "SJS", "TBL"]) expect(teams).toContain(code);
    for (const espnOnly of ["LA", "NJ", "SJ", "TB"]) expect(teams).not.toContain(espnOnly);
  });

  it("keeps the details a post needs", () => {
    expect(reports.find((r) => r.player === "A.J. Greer")).toEqual({
      team: "ANA",
      playerKey: "aj greer",
      player: "A.J. Greer",
      position: "LW",
      status: "day-to-day",
      injury: "Upper Body",
      returnDate: "2026-10-02",
      note: "Greer (upper body) took contact during Wednesday's practice, per Derek Lee of The Hockey News.",
      url: "https://www.espn.com/nhl/player/_/id/3648015",
      updatedAt: Date.parse("2026-09-30T17:52Z"),
    });
  });

  it("drops placeholder notes", () => {
    const helleson = reports.find((r) => r.player === "Drew Helleson")!;
    expect(helleson.status).toBe("ir");
    expect(helleson.note).toBeUndefined();
  });

  it("keeps the newest entry when ESPN lists a player twice", () => {
    const parsed = parseInjuries({
      injuries: [
        {
          displayName: "TOR",
          injuries: [
            espnEntry({ player: "Auston Matthews", team: "TOR", status: "DD", date: "2026-10-01T10:00Z" }),
            espnEntry({ player: "Auston Matthews", team: "TOR", status: "IR", date: "2026-10-02T10:00Z" }),
          ],
        },
      ],
    });
    expect(parsed.map((r) => r.status)).toEqual(["ir"]);
  });

  it.each([
    ["A.J. Greer", "aj greer"],
    ["Jesperi Kotkaniemi", "jesperi kotkaniemi"],
    ["Tim Stützle", "tim stutzle"],
    ["Pierre-Luc Dubois", "pierre luc dubois"],
  ])("playerKey(%s) = %s", (name, key) => {
    expect(playerKey(name)).toBe(key);
  });
});

describe("ESPN data quirks", () => {
  const parse = (entry: Parameters<typeof espnEntry>[0]) =>
    parseInjuries({ injuries: [{ displayName: "x", injuries: [espnEntry(entry)] }] })[0];

  // Real entries from 2026-10-03.
  it("drops ESPN's \"Not Specified\" side", () => {
    expect(parse({ player: "Dylan Larkin", team: "DET", body: "Upper Body", side: "Not Specified" })?.injury).toBe("Upper Body");
    expect(parse({ player: "X Y", team: "DET", body: "Knee", side: "Left" })?.injury).toBe("Left Knee");
    expect(parse({ player: "X Y", team: "DET", body: "Not Specified" })?.injury).toBeUndefined();
  });

  it("treats a suspension filed as IR as a suspension", () => {
    const hellebuyck = parse({ player: "Connor Hellebuyck", team: "WPG", status: "IR", body: "Suspension", note: "ir-nr" });
    expect(hellebuyck).toMatchObject({ status: "suspended", injury: undefined, note: undefined });
  });

  it.each(["ir", "ir-nr", "ltir", "out", "IR"])("drops the placeholder note %j", (note) => {
    expect(parse({ player: "X Y", team: "DET", note })?.note).toBeUndefined();
  });

  it("keeps real notes, even short ones", () => {
    expect(parse({ player: "X Y", team: "DET", note: "Out vs. BOS." })?.note).toBe("Out vs. BOS.");
  });
});

describe("diffInjuries", () => {
  const row = (playerKey: string, over: Partial<SnapshotRow> = {}): SnapshotRow => ({
    team: "TOR",
    playerKey,
    status: "ir",
    injury: "Lower Body",
    returnDate: "2026-10-20",
    updatedAt: 0,
    missing: 0,
    ...over,
  });
  const report = (player: string, over: { status?: "DD" | "O" | "IR"; returnDate?: string; note?: string } = {}) =>
    parseInjuries({ injuries: [{ displayName: "TOR", injuries: [espnEntry({ player, team: "TOR", ...over })] }] })[0]!;

  it("sorts players into added, changed, reappeared and missing", () => {
    const diff = diffInjuries(
      [row("same guy"), row("worse guy", { status: "out" }), row("later return"), row("back guy"), row("flaky guy", { missing: 1 })],
      [
        report("Same Guy", { note: "new note text only" }),
        report("Worse Guy"),
        report("Later Return", { returnDate: "2026-11-01" }),
        report("Flaky Guy"),
        report("New Guy"),
      ],
    );
    expect(diff.added.map((r) => r.player)).toEqual(["New Guy"]);
    expect(diff.changed.map((r) => r.player)).toEqual(["Worse Guy", "Later Return"]);
    expect(diff.reappeared.map((r) => r.player)).toEqual(["Flaky Guy"]);
    expect(diff.missing.map((r) => r.playerKey)).toEqual(["back guy"]);
  });
});
