import type { SnapshotRow } from "../db/injuries";
import type { InjuryReport } from "../sources/espn-injuries";

export interface InjuryDiff {
  /** Not in the last snapshot. */
  added: InjuryReport[];
  /** Status, injury or estimated return changed. ESPN's note text alone doesn't count. */
  changed: InjuryReport[];
  /** Unchanged, but missing from the previous check: reset the miss count. */
  reappeared: InjuryReport[];
  /** In the snapshot but not in this check. */
  missing: SnapshotRow[];
}

const key = (team: string, playerKey: string) => `${team}/${playerKey}`;

export function diffInjuries(snapshot: readonly SnapshotRow[], fresh: readonly InjuryReport[]): InjuryDiff {
  const before = new Map(snapshot.map((r) => [key(r.team, r.playerKey), r]));
  const now = new Set(fresh.map((r) => key(r.team, r.playerKey)));
  const diff: InjuryDiff = { added: [], changed: [], reappeared: [], missing: [] };

  for (const report of fresh) {
    const prev = before.get(key(report.team, report.playerKey));
    if (!prev) diff.added.push(report);
    else if (
      prev.status !== report.status ||
      (prev.injury ?? undefined) !== report.injury ||
      (prev.returnDate ?? undefined) !== report.returnDate
    ) {
      diff.changed.push(report);
    } else if (prev.missing > 0) diff.reappeared.push(report);
  }
  diff.missing = snapshot.filter((r) => !now.has(key(r.team, r.playerKey)));
  return diff;
}
