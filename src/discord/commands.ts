import { EPHEMERAL, InteractionResponseType, type Interaction, type InteractionResponse } from "./types";
import type { Env } from "../env";

/**
 * Slash command definitions, uploaded to Discord by scripts/register-commands.ts.
 * /subscribe, /unsubscribe and /subscriptions arrive in Milestone 2.
 */
export const COMMANDS = [
  {
    name: "ping",
    description: "Check that the NHL Trade Tracker is online.",
  },
] as const;

export async function handleCommand(interaction: Interaction, _env: Env): Promise<InteractionResponse> {
  switch (interaction.data?.name) {
    case "ping":
      return reply("🏒 Pong! NHL Trade Tracker is online.");
    default:
      return reply("Unknown command.");
  }
}

function reply(content: string): InteractionResponse {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL },
  };
}
