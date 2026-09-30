# NHL Trade Tracker

A Discord bot that posts **confirmed** NHL trades, waiver moves and signings to the channels that subscribe to each team. It runs on **Cloudflare Workers** with a **D1** database, so it costs nothing on the free tier and needs no server.

- **Confirmed only.** Posts come only from trusted insiders (Friedman, LeBrun, …) or official NHL and team sources, and only when the wording describes a completed move.
- **No duplicates.** Deduplication happens at three levels: source item, real-world event, and channel.
- **Per-channel team subscriptions.** Each channel can follow specific teams.

## Status

| Milestone | State |
|---|---|
| 1. Skeleton: Worker, D1 schema, `/ping` | ✅ Done |
| 2. `/subscribe`, `/unsubscribe`, `/subscriptions` | ⏳ Next |
| 3. Reddit source (dry-run logging) | ⬜ |
| 4. Confirmed-only filter + classifier tests | ⬜ |
| 5. Dedupe + posting embeds | ⬜ |
| 6. Hardening (first-run backfill, rate limits) | ⬜ |

## How it works

```
Cron (every 2 min) ──► scheduled()  → fetch news → filter → dedupe → post
Discord command    ──► fetch() /interactions → verify signature → handle
```

## Setup

### 1. Install
```bash
npm install
npx wrangler login
```

### 2. Create the database
```bash
npx wrangler d1 create nhl-trade-tracker
```
Paste the printed `database_id` into `wrangler.toml`, then:
```bash
npm run db:migrate:remote
```

### 3. Create the Discord application
1. Go to https://discord.com/developers/applications and select **New Application**.
2. From **General Information**, copy the **Application ID** and **Public Key**.
3. Under **Bot**, select **Reset Token** and copy the **bot token**.
4. Under **Installation**, add the scopes `bot` and `applications.commands` and the permissions **Send Messages**, **Embed Links** and **View Channels**. Then use the install link to add the bot to your server.

### 4. Add secrets and deploy
```bash
npx wrangler secret put DISCORD_APPLICATION_ID
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npm run deploy
```
In the Discord developer portal, set **Interactions Endpoint URL** to
`https://nhl-trade-tracker.<your-subdomain>.workers.dev/interactions` and save. Discord sends a test request, and the bot answers it automatically.

### 5. Register the slash commands
```bash
cp .dev.vars.example .dev.vars   # fill in the values
npm run register-commands
```
If `DISCORD_DEV_GUILD_ID` is set, commands appear in that server instantly. Otherwise they register globally, which can take up to an hour. Then run `/ping` in Discord.

## Development

```bash
npm test                  # unit tests
npm run typecheck
npm run db:migrate:local  # local D1
npm run dev               # local Worker; trigger the cron with:
curl "http://localhost:8787/__scheduled?cron=*/2+*+*+*+*"
```

## Project layout

```
src/index.ts             Worker entry: fetch() for Discord, scheduled() for the cron
src/discord/verify.ts    Ed25519 request signature check
src/discord/commands.ts  Slash command definitions and handlers
src/data/teams.ts        All 32 teams with headline aliases and colours
migrations/              D1 schema
scripts/                 One-off tools (command registration)
test/                    Vitest tests
```
