// Turns reports from any source into changes to one *episode* per injury,
// and decides what (if anything) the channels should see: a new post, a
// reply to the original post, or a quiet edit of it.
import {
  findOpenEpisode,
  hasReportedUpdate,
  insertEpisode,
  insertUpdate,
  saveEpisode,
  type Episode,
  type InjuryUpdate,
} from "../db/injuries";
import type { InjuryStatus } from "../sources/espn-injuries";

/** A source saying "this player is hurt", normalised. */
export interface Observation {
  team: string;
  playerKey: string;
  player: string;
  position?: string;
  status: InjuryStatus;
  injury?: string;
  returnDate?: string;
  note?: string;
  source: "espn" | "reddit";
  /** Who broke it (Reddit tag), e.g. "Michael Russo". */
  reporter?: string;
  threadUrl?: string;
  playerUrl?: string;
  at: number;
}

export type Effect =
  /** Send this update to the subscribed channels. */
  | { kind: "post"; update: InjuryUpdate }
  /** Re-render the episode's original messages in place (no notification). */
  | { kind: "edit"; episodeId: number };

/**
 * Posted the moment they're reported. Day-to-day changes several times a
 * day during the season and would bury the rest; it shows in /injuries.
 */
export const POSTED_STATUSES: ReadonlySet<InjuryStatus> = new Set(["out", "ir", "suspended"]);

/** How long a player is likely out. Moving up is news; moving down is an edit. */
const SEVERITY: Record<InjuryStatus, number> = { "day-to-day": 0, out: 1, suspended: 1, ir: 2 };

/**
 * Records an observation and returns what the channels should see.
 * `silent` (the very first ESPN check) records state without posting.
 */
export async function observe(db: D1Database, o: Observation, opts: { silent?: boolean } = {}): Promise<Effect[]> {
  const open = await findOpenEpisode(db, o.team, o.playerKey);

  if (!open) {
    const episode = await insertEpisode(db, {
      team: o.team,
      playerKey: o.playerKey,
      player: o.player,
      position: o.position ?? null,
      status: o.status,
      injury: o.injury ?? null,
      returnDate: o.returnDate ?? null,
      note: o.note ?? null,
      firstSource: o.source,
      reporter: o.reporter ?? null,
      threadUrl: o.threadUrl ?? null,
      playerUrl: o.playerUrl ?? null,
      espnConfirmed: o.source === "espn",
      openedAt: o.at,
      updatedAt: o.at,
    });
    if (opts.silent || !POSTED_STATUSES.has(o.status)) return [];
    const update = await insertUpdate(db, {
      episodeId: episode.id,
      kind: "reported",
      fromStatus: null,
      toStatus: o.status,
      createdAt: o.at,
    });
    return [{ kind: "post", update }];
  }

  const next = merge(open, o);
  await saveEpisode(db, next);
  if (opts.silent) return [];

  const effects: Effect[] = [];
  const reported = await hasReportedUpdate(db, open.id);
  if (next.status !== open.status && POSTED_STATUSES.has(next.status) && SEVERITY[next.status] >= SEVERITY[open.status]) {
    // Worse (day-to-day → out → IR), or a different serious status (out → suspended).
    const update = await insertUpdate(db, {
      episodeId: open.id,
      kind: reported ? "update" : "reported",
      fromStatus: open.status,
      toStatus: next.status,
      createdAt: o.at,
    });
    effects.push({ kind: "post", update });
  }
  if (reported && displayChanged(open, next)) effects.push({ kind: "edit", episodeId: open.id });
  return effects;
}

/** The player is off every injury list: close the episode, and say so if it was ever posted. */
export async function observeReturn(
  db: D1Database,
  r: { team: string; playerKey: string; at: number },
  opts: { silent?: boolean } = {},
): Promise<Effect[]> {
  const open = await findOpenEpisode(db, r.team, r.playerKey);
  if (!open) return [];
  await saveEpisode(db, { ...open, closedAt: r.at, updatedAt: r.at });
  // Only day-to-day the whole time: never posted, so nothing to close out in Discord.
  if (opts.silent || !(await hasReportedUpdate(db, open.id))) return [];
  const update = await insertUpdate(db, {
    episodeId: open.id,
    kind: "returned",
    fromStatus: open.status,
    toStatus: null,
    createdAt: r.at,
  });
  return [{ kind: "post", update }];
}

/**
 * ESPN is the authority on status and details once it lists a player. A
 * Reddit report only fills gaps, and only ever makes the status *more* serious
 * (a beat writer's "placed on IR" beats ESPN's stale "day-to-day").
 */
function merge(e: Episode, o: Observation): Episode {
  const espn = o.source === "espn";
  return {
    ...e,
    player: espn ? o.player : e.player,
    position: o.position ?? e.position,
    status: espn || SEVERITY[o.status] > SEVERITY[e.status] ? o.status : e.status,
    injury: espn ? (o.injury ?? e.injury) : (e.injury ?? o.injury ?? null),
    returnDate: espn ? (o.returnDate ?? null) : e.returnDate,
    note: espn ? (o.note ?? e.note) : e.note,
    reporter: e.reporter ?? o.reporter ?? null,
    threadUrl: e.threadUrl ?? o.threadUrl ?? null,
    playerUrl: o.playerUrl ?? e.playerUrl,
    espnConfirmed: e.espnConfirmed || espn,
    updatedAt: o.at,
  };
}

/** Anything the original message shows. ESPN's note text alone isn't worth an edit. */
function displayChanged(a: Episode, b: Episode): boolean {
  return (
    a.status !== b.status ||
    a.injury !== b.injury ||
    a.returnDate !== b.returnDate ||
    a.espnConfirmed !== b.espnConfirmed ||
    a.threadUrl !== b.threadUrl ||
    a.reporter !== b.reporter
  );
}
