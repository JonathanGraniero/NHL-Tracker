import { describe, expect, it } from "vitest";
import { TEAMS, getTeam } from "../src/data/teams";

describe("team data", () => {
  it("has all 32 teams with unique codes", () => {
    expect(TEAMS).toHaveLength(32);
    expect(new Set(TEAMS.map((t) => t.code)).size).toBe(32);
  });

  it("has no alias shared by two teams", () => {
    const aliases = TEAMS.flatMap((t) => t.aliases);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("stores aliases in lower case", () => {
    for (const t of TEAMS) for (const a of t.aliases) expect(a).toBe(a.toLowerCase());
  });

  it("looks teams up case-insensitively", () => {
    expect(getTeam("tor")?.name).toBe("Toronto Maple Leafs");
    expect(getTeam("XYZ")).toBeUndefined();
  });
});

import { resolveTeam, searchTeams } from "../src/data/teams";

describe("resolveTeam", () => {
  it.each([
    ["TOR", "TOR"],
    ["toronto maple leafs", "TOR"],
    ["Leafs", "TOR"],
    ["Montreal", "MTL"],
    ["Montréal Canadiens", "MTL"],
    ["  habs ", "MTL"],
  ])("%s → %s", (input, code) => {
    expect(resolveTeam(input)?.code).toBe(code);
  });

  it("returns undefined for unknown or empty input", () => {
    expect(resolveTeam("Nordiques")).toBeUndefined();
    expect(resolveTeam("")).toBeUndefined();
  });
});

describe("searchTeams", () => {
  it("ranks prefix matches before substring matches", () => {
    const codes = searchTeams("an").map((t) => t.code);
    expect(codes[0]).toBe("ANA");
    expect(codes).toContain("VAN"); // "vancouver" contains "an" but doesn't start with it
    expect(codes.indexOf("ANA")).toBeLessThan(codes.indexOf("VAN"));
  });
});
