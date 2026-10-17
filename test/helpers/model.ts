// A stand-in for the Claude API in fetch mocks. Each test says how Claude
// answers the headlines it cares about; anything else isn't a move. How well
// the real model reads headlines is measured by `npm run eval`, not here.
import { splitTag } from "../../src/news/classify";

export interface FakeAnswer {
  move: "trade" | "waiver" | "signing" | "none";
  /** Defaults to true for a move. */
  done?: boolean;
  players?: string[];
  reason?: string;
}

export class FakeClaude {
  /** Set to e.g. 529 to simulate an outage. */
  status = 200;
  /** The headlines Claude was asked about, in order. */
  readonly asked: string[] = [];
  private readonly answers = new Map<string, FakeAnswer>();

  /** By full title; Claude only sees the text after a [Tag]. */
  answer(title: string, answer: FakeAnswer): this {
    this.answers.set(splitTag(title).rest, answer);
    return this;
  }

  handles(url: string): boolean {
    return url.startsWith("https://api.anthropic.com/");
  }

  respond(init: RequestInit | undefined): Response {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] };
    const headline = body.messages[0]!.content.match(/<headline>([\s\S]*)<\/headline>/)![1]!;
    this.asked.push(headline);
    if (this.status !== 200) {
      return Response.json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: this.status });
    }
    const a = this.answers.get(headline) ?? { move: "none" };
    const answer = {
      reason: a.reason ?? (a.move === "none" ? "not a transaction" : "reported as done"),
      move: a.move,
      done: a.done ?? a.move !== "none",
      players: a.players ?? [],
    };
    return Response.json({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: JSON.stringify(answer) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }
}
