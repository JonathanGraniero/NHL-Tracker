import { handleAutocomplete, handleCommand } from "./discord/commands";
import { InteractionResponseType, InteractionType, type Interaction } from "./discord/types";
import { verifyDiscordRequest } from "./discord/verify";
import type { Env } from "./env";

export default {
  /** Discord sends slash commands here (set as the app's Interactions Endpoint URL). */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("NHL Trade Tracker is running.");
    }
    if (request.method !== "POST" || url.pathname !== "/interactions") {
      return new Response("Not found", { status: 404 });
    }

    const body = await request.text();
    const valid = await verifyDiscordRequest(
      env.DISCORD_PUBLIC_KEY,
      request.headers.get("X-Signature-Ed25519"),
      request.headers.get("X-Signature-Timestamp"),
      body,
    );
    if (!valid) {
      return new Response("Bad request signature", { status: 401 });
    }

    const interaction = JSON.parse(body) as Interaction;
    switch (interaction.type) {
      case InteractionType.PING:
        return Response.json({ type: InteractionResponseType.PONG });
      case InteractionType.APPLICATION_COMMAND:
        return Response.json(await handleCommand(interaction, env));
      case InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE:
        return Response.json(await handleAutocomplete(interaction, env));
      default:
        return new Response("Unsupported interaction type", { status: 400 });
    }
  },

  /** Runs on the cron in wrangler.toml. News polling arrives in Milestone 3. */
  async scheduled(controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log(`cron ${controller.cron} fired at ${new Date(controller.scheduledTime).toISOString()}`);
  },
} satisfies ExportedHandler<Env>;
