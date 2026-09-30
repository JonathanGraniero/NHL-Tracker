import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { createTestD1 } from "./helpers/d1";
import { createTestBot, type TestBot } from "./helpers/discord";

let bot: TestBot;

beforeAll(async () => {
  bot = await createTestBot(createTestD1());
});

describe("interactions endpoint", () => {
  it("answers Discord's PING with PONG", async () => {
    const res = await bot.send({ id: "1", type: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  it("replies to /ping privately", async () => {
    const res = await bot.send({ id: "2", type: 2, data: { name: "ping" } });
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain("Pong");
    expect(json.data.flags).toBe(64);
  });

  it("rejects a tampered body", async () => {
    const res = await bot.send({ id: "3", type: 1 }, { tamper: true });
    expect(res.status).toBe(401);
  });

  it("rejects missing signature headers", async () => {
    const res = await worker.fetch(new Request("https://bot.example/interactions", { method: "POST", body: "{}" }), bot.env, bot.ctx);
    expect(res.status).toBe(401);
  });

  it("rejects a malformed signature", async () => {
    const req = new Request("https://bot.example/interactions", {
      method: "POST",
      headers: { "X-Signature-Ed25519": "not-hex", "X-Signature-Timestamp": "1" },
      body: "{}",
    });
    expect((await worker.fetch(req, bot.env, bot.ctx)).status).toBe(401);
  });

  it("returns 404 for other paths", async () => {
    const res = await worker.fetch(new Request("https://bot.example/nope", { method: "POST" }), bot.env, bot.ctx);
    expect(res.status).toBe(404);
  });
});
