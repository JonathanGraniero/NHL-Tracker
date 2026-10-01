import { expect } from "vitest";
// Builds requests signed the same way Discord signs them, so tests exercise
// the real signature check instead of bypassing it.
import worker from "../../src/index";
import type { Env } from "../../src/env";
import type { CommandOption, Interaction, InteractionResponse } from "../../src/discord/types";

const toHex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** An interaction as a test sends it: only `type` is required, so tests can also send PINGs and malformed payloads. */
export type InteractionPayload = Pick<Interaction, "type"> & Partial<Omit<Interaction, "type">>;

/** The JSON body of a request the code under test sent (for fetch mocks). */
export function requestJson<T>(init: RequestInit | undefined): T {
  return JSON.parse(String(init?.body)) as T;
}

export interface TestBot {
  env: Env;
  /** Collects ctx.waitUntil() work; await settle() to let it finish. */
  ctx: ExecutionContext;
  settle(): Promise<void>;
  send(payload: InteractionPayload, opts?: { tamper?: boolean }): Promise<Response>;
  /** Runs a slash command and returns the reply text. */
  command(name: string, options?: Record<string, string | boolean>, ctx?: Ctx): Promise<string>;
  /** Runs autocomplete for a command's focused option and returns the choices. */
  autocomplete(name: string, option: string, typed: string, ctx?: Ctx): Promise<{ name: string; value: string }[]>;
}

interface Ctx {
  guildId?: string | null;
  channelId?: string;
}

export async function createTestBot(db: D1Database): Promise<TestBot> {
  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const env: Env = {
    DB: db,
    DISCORD_APPLICATION_ID: "123",
    DISCORD_PUBLIC_KEY: toHex((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer),
    DISCORD_BOT_TOKEN: "unused",
  };

  let nextId = 1;
  const pending: Promise<unknown>[] = [];
  // Only the methods the Worker calls; the rest of ExecutionContext isn't used.
  const fakeCtx: Pick<ExecutionContext, "waitUntil" | "passThroughOnException"> = {
    waitUntil: (p) => void pending.push(p),
    passThroughOnException: () => {},
  };
  const ctx = fakeCtx as ExecutionContext;

  async function send(payload: InteractionPayload, opts: { tamper?: boolean } = {}): Promise<Response> {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + body));
    const req = new Request("https://bot.example/interactions", {
      method: "POST",
      headers: { "X-Signature-Ed25519": toHex(sig), "X-Signature-Timestamp": timestamp },
      body: opts.tamper ? body.replace("}", ',"x":1}') : body,
    });
    return worker.fetch(req, env, ctx);
  }

  function interaction(type: number, name: string, options: CommandOption[], ctx: Ctx): InteractionPayload {
    return {
      id: String(nextId++),
      application_id: env.DISCORD_APPLICATION_ID,
      token: `interaction-token-${nextId}`,
      type,
      ...(ctx.guildId === null ? {} : { guild_id: ctx.guildId ?? "guild-1" }),
      channel_id: ctx.channelId ?? "channel-1",
      data: { name, options },
    };
  }

  return {
    env,
    ctx,
    async settle() {
      while (pending.length > 0) await Promise.all(pending.splice(0));
    },
    send,
    async command(name, options = {}, ctx = {}) {
      const opts = Object.entries(options).map(([n, value]) => ({
        name: n,
        type: typeof value === "boolean" ? 5 : 3,
        value,
      }));
      const res = await send(interaction(2, name, opts, ctx));
      const json = (await res.json()) as InteractionResponse;
      return json.data?.content ?? "";
    },
    async autocomplete(name, option, typed, ctx = {}) {
      const res = await send(interaction(4, name, [{ name: option, type: 3, value: typed, focused: true }], ctx));
      const json = (await res.json()) as InteractionResponse;
      expect(json.type).toBe(8);
      return json.data?.choices ?? [];
    },
  };
}
