import { getTeam } from "../data/teams";
import type { MessageBody } from "../discord/api";
import type { NewsEvent } from "../db/events";
import type { TransactionType } from "../types";

const HEADINGS: Record<TransactionType, string> = {
  trade: "🔁 Trade",
  waiver: "📋 Waivers",
  signing: "✍️ Signing",
};

/** The Discord message for a confirmed move. */
export function buildMessage(event: NewsEvent): MessageBody {
  const teamNames = event.teams.map((code) => getTeam(code)?.name ?? code);
  const joiner = event.type === "trade" ? " ↔ " : ", ";
  return {
    embeds: [
      {
        title: truncate(`${HEADINGS[event.type]}: ${teamNames.join(joiner)}`, 256),
        description: truncate(event.headline.replace(/^\[[^\]]+\]\s*:?\s*/, ""), 4000),
        url: canonicalLink(event.link) ?? event.url,
        color: getTeam(event.teams[0] ?? "")?.color,
        timestamp: new Date(event.publishedAt).toISOString(),
        fields: [
          { name: "Source", value: event.source, inline: true },
          { name: "Discussion", value: `[r/hockey](${event.url})`, inline: true },
        ],
        footer: { text: "NHL Tracker · confirmed moves only" },
      },
    ],
  };
}

/** xcancel/nitter mirrors → x.com, without tracking parameters. */
export function canonicalLink(link: string | null): string | undefined {
  if (!link) return undefined;
  try {
    const url = new URL(link);
    if (/^(xcancel\.com|nitter\.[a-z.]+|twitter\.com|mobile\.twitter\.com)$/.test(url.hostname)) url.hostname = "x.com";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
