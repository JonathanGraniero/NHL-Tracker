// NHL.com's own transaction news: every team's site posts signings, trades,
// waivers, recalls and assignments as stories tagged "transactions" in
// NHL.com's content API (public, no key). It's the official record, and it
// covers moves that never make r/hockey, like a prospect's entry-level deal
// posted only on a team subreddit.
import { nhlComPath, resolveTeam } from "../data/teams";
import type { SourceItem } from "./reddit";

const FEED_URL = "https://forge-dapi.d3.nhle.com/v2/content/en-us/stories?tags.slug=transactions&$limit=20";

/** The parts of the content API's story list the bot reads. */
export interface NhlStoriesResponse {
  items?: NhlStory[];
}

export interface NhlStory {
  slug: string;
  title: string;
  headline?: string;
  /** ISO publish time. */
  contentDate: string;
  /** "teamid-2" for a team's site, "nhl" for NHL.com itself. */
  context?: { slug?: string; title?: string };
  /** Includes one "teamid-N" tag titled with the team's name. */
  tags?: { slug: string; title?: string }[];
}

export class NhlNewsError extends Error {
  constructor(readonly status: number) {
    super(`NHL.com news responded ${status}`);
  }
}

/** The newest transaction stories, oldest first. */
export async function fetchTransactions(): Promise<SourceItem[]> {
  const res = await fetch(FEED_URL, {
    headers: { "User-Agent": "nhl-tracker (+https://github.com/JonathanGraniero/NHL-Tracker)" },
  });
  if (!res.ok) throw new NhlNewsError(res.status);
  return parseStories(await res.json<NhlStoriesResponse>()).reverse();
}

export function parseStories(raw: NhlStoriesResponse): SourceItem[] {
  return (raw.items ?? []).flatMap((story): SourceItem[] => {
    const publishedAt = Date.parse(story.contentDate);
    if (!story.slug || Number.isNaN(publishedAt)) return [];
    const url = storyUrl(story);
    return [
      {
        source: "nhl",
        id: `nhl:${story.slug}`,
        // A few stories have their slug as the title; the headline reads better then.
        title: (story.title.includes(" ") ? story.title : (story.headline ?? story.title)).trim(),
        url,
        links: [url],
        publishedAt,
      },
    ];
  });
}

/** nhl.com/islanders/news/islanders-sign-dravecky, or nhl.com/news/… for league stories. */
export function storyUrl(story: NhlStory): string {
  const teamTag = story.tags?.find((t) => t.slug.startsWith("teamid-") && t.slug === story.context?.slug);
  const team = teamTag?.title ? resolveTeam(teamTag.title) : undefined;
  const path = team ? nhlComPath(team.code) : undefined;
  return path ? `https://www.nhl.com/${path}/news/${story.slug}` : `https://www.nhl.com/news/${story.slug}`;
}

/** "https://www.nhl.com/islanders/news/islanders-sign-dravecky?fbclid=…" → "islanders-sign-dravecky". */
export function storySlugFromUrl(input: string): string | undefined {
  return input.trim().match(/^https?:\/\/(?:www\.)?nhl\.com\/(?:[a-z]+\/)?news\/([a-z0-9-]+)/i)?.[1]?.toLowerCase();
}

/** One story by slug (for /replay), or undefined if NHL.com doesn't have it. */
export async function fetchStory(slug: string): Promise<SourceItem | undefined> {
  const res = await fetch(`https://forge-dapi.d3.nhle.com/v2/content/en-us/stories/${slug}`, {
    headers: { "User-Agent": "nhl-tracker (+https://github.com/JonathanGraniero/NHL-Tracker)" },
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new NhlNewsError(res.status);
  return parseStories({ items: [await res.json<NhlStory>()] })[0];
}
