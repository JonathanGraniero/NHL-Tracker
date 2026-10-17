import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeReader, MODEL } from "../src/news/model";
import { FakeClaude } from "./helpers/model";

const HEADLINE = { text: "Gaudet (STL) on waivers", source: "Elliotte Friedman", sourceKind: "insider" as const };

let claude: FakeClaude;
let requests: { url: string; headers: Headers; body: Record<string, unknown> }[];
let override: Response | undefined;

beforeEach(() => {
  claude = new FakeClaude();
  requests = [];
  override = undefined;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!claude.handles(url)) throw new Error(`unexpected fetch ${url}`);
    requests.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return override ?? claude.respond(init);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("claudeReader", () => {
  it("asks Claude for a structured answer about the headline", async () => {
    claude.answer("Gaudet (STL) on waivers", { move: "waiver", players: ["Gaudet"] });
    expect(await claudeReader("key-1")(HEADLINE)).toEqual({ ok: true, move: "waiver", done: true, players: ["Gaudet"], reason: "reported as done" });

    const [req] = requests;
    expect(req!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req!.headers.get("x-api-key")).toBe("key-1");
    expect(req!.body).toMatchObject({ model: MODEL, output_config: { effort: "medium", format: { type: "json_schema" } } });
    const content = (req!.body.messages as { content: string }[])[0]!.content;
    expect(content).toContain("Source: Elliotte Friedman (NHL insider, posted on r/hockey)");
    expect(content).toContain("<headline>Gaudet (STL) on waivers</headline>");
  });

  it("says try again later when the API is down, without retrying in this run", async () => {
    claude.status = 529;
    expect(await claudeReader("key-1")(HEADLINE)).toEqual({ ok: false, unavailable: true, reason: "Claude API 529" });
    expect(requests).toHaveLength(1);
  });

  it("skips just this headline when Claude declines it", async () => {
    override = Response.json({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [],
      stop_reason: "refusal",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    expect(await claudeReader("key-1")(HEADLINE)).toEqual({ ok: false, unavailable: false, reason: "Claude declined to read this headline" });
  });
});
