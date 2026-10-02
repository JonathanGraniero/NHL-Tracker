import { getTeam } from "../data/teams";
import type { Embed, MessageBody } from "../discord/api";
import type { Episode, InjuryUpdate } from "../db/injuries";
import type { InjuryStatus } from "../sources/espn-injuries";

export const STATUS_LABELS: Record<InjuryStatus, string> = {
  "day-to-day": "Day-to-day",
  out: "Out",
  ir: "Injured reserve",
  suspended: "Suspended",
};

const FOOTER = { text: "NHL Tracker · injuries" };
/** Leave room under Discord's 4096-character embed description limit. */
const MAX_LIST = 3900;

/** The first post about an episode, also used to re-render it when it changes. */
export function reportedMessage(e: Episode): MessageBody {
  return {
    embeds: [
      {
        title: `${e.status === "suspended" ? "⚖️" : "🩹"} ${playerLabel(e)} · ${teamName(e.team)}`,
        url: e.threadUrl ?? e.playerUrl ?? undefined,
        color: getTeam(e.team)?.color,
        description: [statusLine(e), quote(e.note), sourceLine(e)].filter(Boolean).join("\n"),
        timestamp: new Date(e.openedAt).toISOString(),
        footer: FOOTER,
      },
    ],
  };
}

/** A reply to the original post: the injury got more serious, or changed kind. */
export function updateMessage(e: Episode, u: InjuryUpdate): MessageBody {
  const from = u.fromStatus ? `${STATUS_LABELS[u.fromStatus]} → ` : "";
  const to = u.toStatus ?? e.status;
  return {
    embeds: [
      {
        title: `📈 ${playerLabel(e)} · ${teamName(e.team)}`,
        url: e.threadUrl ?? e.playerUrl ?? undefined,
        color: getTeam(e.team)?.color,
        description: [`${from}**${STATUS_LABELS[to]}**${details(e)}`, quote(e.note)].filter(Boolean).join("\n"),
        timestamp: new Date(u.createdAt).toISOString(),
        footer: FOOTER,
      },
    ],
  };
}

/** A reply to the original post: he's off the injury list. */
export function returnedMessage(e: Episode, u: InjuryUpdate): MessageBody {
  return {
    embeds: [
      {
        title: `✅ ${playerLabel(e)} is off the injury list · ${teamName(e.team)}`,
        url: e.playerUrl ?? undefined,
        color: getTeam(e.team)?.color,
        description: `Was: ${STATUS_LABELS[u.fromStatus ?? e.status]}${e.injury ? ` (${e.injury.toLowerCase()})` : ""}`,
        timestamp: new Date(u.createdAt).toISOString(),
        footer: FOOTER,
      },
    ],
  };
}

export function messageFor(e: Episode, u: InjuryUpdate): MessageBody {
  if (u.kind === "returned") return returnedMessage(e, u);
  if (u.kind === "update") return updateMessage(e, u);
  return reportedMessage(e);
}

/** /injuries: open episodes, grouped by team when there's more than one. */
export function injuryListMessage(episodes: readonly Episode[], opts: { team?: string } = {}): MessageBody {
  const title = `🩹 Injuries · ${opts.team ? teamName(opts.team) : "NHL"}`;
  if (episodes.length === 0) {
    return { embeds: [{ title, description: "Nobody on the injury list. 🎉", footer: FOOTER }] };
  }
  const lines: string[] = [];
  let lastTeam: string | undefined;
  for (const e of episodes) {
    if (!opts.team && e.team !== lastTeam) lines.push(`${lines.length ? "\n" : ""}**${teamName(e.team)}**`);
    lastTeam = e.team;
    lines.push(`• ${playerLabel(e)}: ${STATUS_LABELS[e.status]}${details(e)}`);
  }
  let description = lines.join("\n");
  if (description.length > MAX_LIST) {
    const cut = description.lastIndexOf("\n", MAX_LIST);
    const shown = description.slice(0, cut);
    const hidden = episodes.length - shown.split("\n").filter((l) => l.startsWith("•")).length;
    description = `${shown}\n…and ${hidden} more. Add \`team:\` to see one team.`;
  }
  const embed: Embed = {
    title,
    description,
    color: opts.team ? getTeam(opts.team)?.color : undefined,
    footer: { text: "NHL Tracker · injuries · from ESPN and r/hockey" },
  };
  return { embeds: [embed] };
}

function statusLine(e: Episode): string {
  return `**${STATUS_LABELS[e.status]}**${details(e)}`;
}

/** " · lower body · est. return Oct 20" */
function details(e: Episode): string {
  const parts = [e.injury?.toLowerCase(), e.returnDate ? `est. return ${shortDate(e.returnDate)}` : undefined];
  return parts.filter(Boolean).map((p) => ` · ${p}`).join("");
}

function sourceLine(e: Episode): string {
  const thread = e.threadUrl ? ` · [r/hockey](${e.threadUrl})` : "";
  if (e.firstSource === "reddit") {
    const reporter = e.reporter ? `First reported by **${e.reporter}**` : "First reported on r/hockey";
    return `${reporter}${thread}${e.espnConfirmed ? " · ✓ confirmed by ESPN" : ""}`;
  }
  return `via ESPN${thread}`;
}

function quote(note: string | null): string | undefined {
  return note ? `> ${note.length > 300 ? `${note.slice(0, 299)}…` : note}` : undefined;
}

function playerLabel(e: Episode): string {
  return e.position ? `${e.player} (${e.position})` : e.player;
}

function teamName(code: string): string {
  return getTeam(code)?.name ?? code;
}

/** "2026-10-20" → "Oct 20" */
function shortDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T12:00:00Z`),
  );
}
