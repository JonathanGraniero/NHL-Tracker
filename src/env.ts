export interface Env {
  DB: D1Database;
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  /** Claude API key: Claude reads the wording of trusted news posts (src/news/model.ts). */
  ANTHROPIC_API_KEY: string;
}
