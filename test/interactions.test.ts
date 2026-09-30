import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

let keys: CryptoKeyPair;
let env: Env;

const toHex = (buf: ArrayBuffer) => Buffer.from(buf).toString("hex");

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  env = {
    DB: {} as D1Database,
    DISCORD_APPLICATION_ID: "123",
    DISCORD_PUBLIC_KEY: toHex(await crypto.subtle.exportKey("raw", keys.publicKey) as ArrayBuffer),
    DISCORD_BOT_TOKEN: "unused",
  };
});

async function signedRequest(payload: unknown, opts: { tamper?: boolean } = {}): Promise<Request> {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + body));
  return new Request("https://bot.example/interactions", {
    method: "POST",
    headers: { "X-Signature-Ed25519": toHex(sig), "X-Signature-Timestamp": timestamp },
    body: opts.tamper ? body.replace("}", ',"x":1}') : body,
  });
}

const call = (req: Request) => worker.fetch(req, env);

describe("interactions endpoint", () => {
  it("answers Discord's PING with PONG", async () => {
    const res = await call(await signedRequest({ id: "1", type: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  it("replies to /ping", async () => {
    const res = await call(await signedRequest({ id: "2", type: 2, data: { name: "ping" } }));
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain("Pong");
    expect(json.data.flags).toBe(64);
  });

  it("rejects a tampered body", async () => {
    const res = await call(await signedRequest({ id: "3", type: 1 }, { tamper: true }));
    expect(res.status).toBe(401);
  });

  it("rejects missing signature headers", async () => {
    const res = await call(new Request("https://bot.example/interactions", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });

  it("rejects a malformed signature", async () => {
    const req = await signedRequest({ id: "4", type: 1 });
    req.headers.set("X-Signature-Ed25519", "not-hex");
    expect((await call(req)).status).toBe(401);
  });

  it("returns 404 for other paths", async () => {
    const res = await call(new Request("https://bot.example/nope", { method: "POST" }));
    expect(res.status).toBe(404);
  });
});
