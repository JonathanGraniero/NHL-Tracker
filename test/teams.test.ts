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
