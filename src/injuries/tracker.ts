// Every 10 minutes: compare ESPN's injury list with the last one and turn
// the differences into episode changes and Discord posts.
import { Budget, deliver, resumePending } from "./deliver";
import { diffInjuries } from "./diff";
import { observe, observeReturn, type Effect, type Observation } from "./episodes";
import { getState, setState } from "../db/events";
import { baselineInjuries, deleteSnapshot, readSnapshot, setSnapshotMissing, upsertSnapshot } from "../db/injuries";
import { EspnError, fetchInjuries, type InjuryReport } from "../sources/espn-injuries";
import type { Env } from "../env";

/** Must match the injury entry in infra/variables.tf (cron_schedules). */
export const INJURY_CRON = "*/10 * * * *";
const READY_KEY = "injuries_ready";
/** Checks in a row a player must be missing before he counts as back. */
const MISSES_TO_RETURN = 2;
/** Changes applied per run; the rest are still differences next run. Keeps D1 queries per invocation low. */
const MAX_CHANGES = 30;
/** Discord calls per run, under Workers Free's 50 outside requests (ESPN is one). */
const DISCORD_BUDGET = 40;

export async function runInjuryCheck(env: Env, now: number): Promise<void> {
  const budget = new Budget(DISCORD_BUDGET);
  // Finish anything an earlier run recorded but didn't get to send.
  await resumePending(env, now, budget);

  let fresh: InjuryReport[];
  try {
    fresh = await fetchInjuries();
  } catch (err) {
    if (err instanceof EspnError) {
      console.warn(`injuries: ${err.message}, trying again next run`);
      return;
    }
    throw err;
  }

  if (!(await getState(env.DB, READY_KEY))) {
    // First run: remember who's hurt now without announcing all of it.
    await baselineInjuries(env.DB, fresh, now);
    await setState(env.DB, READY_KEY, String(now));
    console.log(`injuries: first run, recorded ${fresh.length} current injuries without posting`);
    return;
  }

  const snapshot = await readSnapshot(env.DB);
  // A response missing most of the league is a glitch, not a wave of recoveries.
  if (snapshot.length >= 20 && fresh.length < snapshot.length / 2) {
    console.warn(`injuries: ESPN listed ${fresh.length} injuries (was ${snapshot.length}), skipping this check`);
    return;
  }

  const diff = diffInjuries(snapshot, fresh);
  const effects: Effect[] = [];
  let applied = 0;

  for (const report of [...diff.added, ...diff.changed]) {
    if (applied++ >= MAX_CHANGES) break;
    effects.push(...(await observe(env.DB, observationFrom(report, now))));
    await upsertSnapshot(env.DB, {
      team: report.team,
      playerKey: report.playerKey,
      status: report.status,
      injury: report.injury ?? null,
      returnDate: report.returnDate ?? null,
      updatedAt: report.updatedAt,
    });
  }
  for (const row of diff.missing) {
    if (applied++ >= MAX_CHANGES) break;
    if (row.missing + 1 >= MISSES_TO_RETURN) {
      effects.push(...(await observeReturn(env.DB, { team: row.team, playerKey: row.playerKey, at: now })));
      await deleteSnapshot(env.DB, row.team, row.playerKey);
    } else {
      await setSnapshotMissing(env.DB, row.team, row.playerKey, row.missing + 1);
    }
  }
  for (const report of diff.reappeared) await setSnapshotMissing(env.DB, report.team, report.playerKey, 0);

  const result = await deliver(env, effects, now, budget);
  if (applied > 0 || result.posted > 0 || result.deferred > 0) {
    console.log(
      `injuries: ${diff.added.length} new, ${diff.changed.length} changed, ${diff.missing.length} missing; ` +
        `posted ${result.posted}, edited ${result.edited}, failed ${result.failed}, deferred ${result.deferred}`,
    );
  }
}

function observationFrom(r: InjuryReport, now: number): Observation {
  return {
    team: r.team,
    playerKey: r.playerKey,
    player: r.player,
    position: r.position,
    status: r.status,
    injury: r.injury,
    returnDate: r.returnDate,
    note: r.note,
    source: "espn",
    playerUrl: r.url,
    at: now,
  };
}
