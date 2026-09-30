// Uploads the slash command definitions to Discord.
// Usage: npm run register-commands   (reads .dev.vars)
//
// With DISCORD_DEV_GUILD_ID set, commands register to that one server and
// appear instantly. Without it they register globally (can take up to an hour).
import { readFileSync, existsSync } from "node:fs";
import { COMMANDS } from "../src/discord/commands";

function loadDevVars(): Record<string, string> {
  if (!existsSync(".dev.vars")) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match?.[1] && match[2]) vars[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return vars;
}

const vars = { ...loadDevVars(), ...process.env };
const appId = vars.DISCORD_APPLICATION_ID;
const token = vars.DISCORD_BOT_TOKEN;
const guildId = vars.DISCORD_DEV_GUILD_ID;

if (!appId || !token) {
  console.error("Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN in .dev.vars or the environment.");
  process.exit(1);
}

const url = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;

const res = await fetch(url, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(COMMANDS),
});

if (!res.ok) {
  console.error(`Failed (${res.status}): ${await res.text()}`);
  process.exit(1);
}
console.log(`Registered ${COMMANDS.length} command(s) ${guildId ? `to guild ${guildId}` : "globally"}.`);
