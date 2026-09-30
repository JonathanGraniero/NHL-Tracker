// The subset of the Discord interactions API this bot uses.
// https://discord.com/developers/docs/interactions/receiving-and-responding

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  /** "Bot is thinking…"; the real reply follows via editOriginalResponse. */
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
} as const;

export const OptionType = {
  STRING: 3,
  BOOLEAN: 5,
} as const;

/** Message flag: only the user who ran the command can see the reply. */
export const EPHEMERAL = 1 << 6;

/** Discord allows at most 25 autocomplete choices. */
export const MAX_CHOICES = 25;

export interface CommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  focused?: boolean;
}

export interface Interaction {
  id: string;
  application_id: string;
  /** Lets the bot edit its reply for 15 minutes after the interaction. */
  token: string;
  type: number;
  guild_id?: string;
  channel_id?: string;
  data?: {
    name: string;
    options?: CommandOption[];
  };
}

export interface Choice {
  name: string;
  value: string;
}

export interface InteractionResponse {
  type: number;
  data?: {
    content?: string;
    flags?: number;
    choices?: Choice[];
  };
}
