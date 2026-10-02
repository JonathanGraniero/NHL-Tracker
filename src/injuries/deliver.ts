// Sends injury updates to subscribed channels and keeps earlier messages
// current. Updates are recorded before sending, so if a run stops partway
// (crash, or out of request budget) the next run finishes the job.
import { createMessage, editMessage } from "../discord/api";
import {
  getEpisode,
  markUpdateDone,
  pendingUpdates,
  postedChannelsForUpdate,
  recordInjuryPost,
  rootMessages,
  type InjuryUpdate,
} from "../db/injuries";
import { findChannelsFor } from "../db/subscriptions";
import { messageFor, reportedMessage } from "./format";
import type { Effect } from "./episodes";
import type { Env } from "../env";

/** Unsent updates older than this are dropped rather than posted late. */
const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Discord calls one run may make. Workers Free allows 50 outside requests per
 * invocation, and the ESPN fetch is one of them.
 */
export class Budget {
  constructor(private remaining: number) {}
  take(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining--;
    return true;
  }
  get exhausted(): boolean {
    return this.remaining <= 0;
  }
}

export interface DeliveryResult {
  posted: number;
  edited: number;
  failed: number;
  /** Updates left for the next run because the budget ran out. */
  deferred: number;
}

export async function deliver(env: Env, effects: readonly Effect[], now: number, budget: Budget): Promise<DeliveryResult> {
  const result: DeliveryResult = { posted: 0, edited: 0, failed: 0, deferred: 0 };
  const posted = new Set<number>();
  for (const effect of effects) {
    if (effect.kind !== "post") continue;
    await sendUpdate(env, effect.update, now, budget, result);
    if (effect.update.kind === "reported") posted.add(effect.update.episodeId);
  }
  // A just-posted original already shows the current state.
  const edits = new Set(effects.flatMap((e) => (e.kind === "edit" && !posted.has(e.episodeId) ? [e.episodeId] : [])));
  for (const episodeId of edits) await refreshOriginals(env, episodeId, budget, result);
  return result;
}

/** Finishes updates an earlier run recorded but didn't get to send everywhere. */
export async function resumePending(env: Env, now: number, budget: Budget): Promise<DeliveryResult> {
  const result: DeliveryResult = { posted: 0, edited: 0, failed: 0, deferred: 0 };
  for (const update of await pendingUpdates(env.DB, now - RESUME_WINDOW_MS)) {
    await sendUpdate(env, update, now, budget, result);
  }
  return result;
}

async function sendUpdate(env: Env, update: InjuryUpdate, now: number, budget: Budget, result: DeliveryResult) {
  const episode = await getEpisode(env.DB, update.episodeId);
  if (!episode) return;
  const already = await postedChannelsForUpdate(env.DB, update.id);
  const channels = (await findChannelsFor(env.DB, [episode.team], "injuries")).filter((c) => !already.has(c));
  // Replies thread under the original in channels that got it; elsewhere they stand alone.
  const roots = update.kind === "reported" ? new Map<string, string>() : new Map((await rootMessages(env.DB, episode.id)).map((r) => [r.channelId, r.messageId]));
  const body = messageFor(episode, update);

  for (const channelId of channels) {
    if (!budget.take()) {
      result.deferred++;
      return; // not marked done: the next run picks it up
    }
    const root = roots.get(channelId);
    const sent = await createMessage(
      env.DISCORD_BOT_TOKEN,
      channelId,
      root ? { ...body, message_reference: { message_id: root, fail_if_not_exists: false } } : body,
    );
    if (sent.ok) {
      await recordInjuryPost(env.DB, { updateId: update.id, channelId, messageId: sent.id }, now);
      result.posted++;
    } else {
      // Not retried: a missing permission won't fix itself by the next run.
      console.error(`injury post to ${channelId} failed (${sent.status}): ${sent.error}`);
      result.failed++;
    }
  }
  await markUpdateDone(env.DB, update.id);
}

async function refreshOriginals(env: Env, episodeId: number, budget: Budget, result: DeliveryResult) {
  const episode = await getEpisode(env.DB, episodeId);
  if (!episode) return;
  const body = reportedMessage(episode);
  for (const { channelId, messageId } of await rootMessages(env.DB, episodeId)) {
    if (!budget.take()) return; // edits are cosmetic; the next change re-renders anyway
    const res = await editMessage(env.DISCORD_BOT_TOKEN, channelId, messageId, body);
    if (res.ok) result.edited++;
    else console.error(`injury edit in ${channelId} failed (${res.status}): ${res.error}`);
  }
}
