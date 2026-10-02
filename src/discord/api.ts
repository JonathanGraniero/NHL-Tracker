// Outgoing calls to Discord's REST API (posting news, finishing deferred replies).
// https://discord.com/developers/docs/reference

const API = "https://discord.com/api/v10";

export interface Embed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
}

export interface MessageBody {
  content?: string;
  embeds?: Embed[];
  flags?: number;
  allowed_mentions?: { parse: string[] };
  /** Makes the message a reply. fail_if_not_exists: false still sends it if the original was deleted. */
  message_reference?: { message_id: string; fail_if_not_exists?: boolean };
}

export type SendResult = { ok: true; id: string } | { ok: false; status: number; error: string };

/** The part of Discord's Message object the bot reads. */
interface DiscordMessage {
  id: string;
}

/** Body of a 429 response. https://discord.com/developers/docs/topics/rate-limits */
interface RateLimitResponse {
  /** Seconds to wait. */
  retry_after: number;
  global?: boolean;
}

/** Posts a message to a channel as the bot. */
export async function createMessage(botToken: string, channelId: string, body: MessageBody): Promise<SendResult> {
  const res = await discordFetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}` },
    body: { allowed_mentions: { parse: [] }, ...body },
  });
  if (!res.ok) return { ok: false, status: res.status, error: await res.text() };
  return { ok: true, id: (await res.json<DiscordMessage>()).id };
}

/** Rewrites one of the bot's own messages in place (no new notification). */
export async function editMessage(
  botToken: string,
  channelId: string,
  messageId: string,
  body: MessageBody,
): Promise<SendResult> {
  const res = await discordFetch(`${API}/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: { Authorization: `Bot ${botToken}` },
    body,
  });
  if (!res.ok) return { ok: false, status: res.status, error: await res.text() };
  return { ok: true, id: messageId };
}

/** Replaces the "thinking…" placeholder of a deferred interaction reply. */
export async function editOriginalResponse(appId: string, interactionToken: string, body: MessageBody): Promise<void> {
  const res = await discordFetch(`${API}/webhooks/${appId}/${interactionToken}/messages/@original`, {
    method: "PATCH",
    body,
  });
  if (!res.ok) console.error(`editOriginalResponse failed (${res.status}): ${await res.text()}`);
}

/** fetch() with JSON encoding and a single retry when Discord rate-limits us briefly. */
async function discordFetch(
  url: string,
  init: { method: "POST" | "PATCH"; headers?: Record<string, string>; body: MessageBody },
): Promise<Response> {
  const request = () =>
    fetch(url, {
      method: init.method,
      headers: { "Content-Type": "application/json", ...init.headers },
      body: JSON.stringify(init.body),
    });
  const res = await request();
  if (res.status !== 429) return res;
  const retryAfter = (await res.clone().json<Partial<RateLimitResponse>>()).retry_after ?? 1;
  if (retryAfter > 5) return res;
  await new Promise<void>((resolve) => setTimeout(resolve, retryAfter * 1000));
  return request();
}
