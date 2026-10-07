// r/hockey is where insider reports and team announcements land first.
// Reddit blocks anonymous JSON API calls from Workers (403) but serves the
// Atom (RSS) feeds, with a small rate limit shared across Cloudflare's IPs,
// so a 429 is normal and the next cron run simply tries again.

export interface SourceItem {
  /** Where it came from: r/hockey, or NHL.com's transactions feed. */
  source: "reddit" | "nhl";
  /** Reddit fullname, e.g. "t3_1wsqy36". */
  id: string;
  title: string;
  /** Permalink to the Reddit thread. */
  url: string;
  /** Links in the post other than Reddit's own (tweets, nhl.com articles, …). */
  links: string[];
  /** Unix ms. */
  publishedAt: number;
}

export class RedditError extends Error {
  constructor(readonly status: number) {
    super(`Reddit responded ${status}`);
  }
}

const NEW_POSTS_URL = "https://www.reddit.com/r/hockey/new.rss?limit=100";
const USER_AGENT = "cloudflare-worker:nhl-tracker:0.1 (+https://github.com/JonathanGraniero/NHL-Tracker)";

/** The newest 100 r/hockey posts, oldest first. */
export async function fetchNewPosts(): Promise<SourceItem[]> {
  return parseFeed(await fetchFeed(NEW_POSTS_URL)).reverse();
}

/** One post by fullname ("t3_…"), or undefined if Reddit doesn't know it. */
export async function fetchPost(id: string): Promise<SourceItem | undefined> {
  return parseFeed(await fetchFeed(`https://www.reddit.com/by_id/${id}.rss`))[0];
}

async function fetchFeed(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new RedditError(res.status);
  return res.text();
}

/**
 * Accepts a post URL (reddit.com/r/…/comments/<id>/…, redd.it/<id>),
 * a fullname ("t3_<id>") or a bare id, and returns the fullname.
 */
export function postIdFromInput(input: string): string | undefined {
  const s = input.trim();
  const match =
    s.match(/\/comments\/([a-z0-9]+)/i) ??
    s.match(/redd\.it\/([a-z0-9]+)/i) ??
    s.match(/^t3_([a-z0-9]+)$/i) ??
    s.match(/^([a-z0-9]{5,10})$/i);
  return match?.[1] ? `t3_${match[1].toLowerCase()}` : undefined;
}

/** Parses Reddit's Atom feed. Reddit's markup is regular enough that a DOM parser isn't needed. */
export function parseFeed(xml: string): SourceItem[] {
  const items: SourceItem[] = [];
  for (const [, entry = ""] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = tag(entry, "id");
    const title = tag(entry, "title");
    const url = entry.match(/<link href="([^"]+)"/)?.[1];
    const published = tag(entry, "published") ?? tag(entry, "updated");
    if (!id?.startsWith("t3_") || !title || !url || !published) continue;

    // <content> is HTML that has been escaped once more for the XML.
    const html = decodeEntities(tag(entry, "content") ?? "");
    const links = [...html.matchAll(/href="([^"]+)"/g)]
      .map(([, href = ""]) => decodeEntities(href))
      .filter((href) => !/^https?:\/\/([a-z0-9-]+\.)*(reddit\.com|redd\.it|redditmedia\.com)\//i.test(href));

    items.push({
      source: "reddit",
      id,
      title: decodeEntities(title).replace(/\s+/g, " ").trim(),
      url: decodeEntities(url),
      links: [...new Set(links)],
      publishedAt: Date.parse(published),
    });
  }
  return items;
}

function tag(xml: string, name: string): string | undefined {
  return xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1];
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}
