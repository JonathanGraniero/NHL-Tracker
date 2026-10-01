# NHL Trade Tracker

A Discord bot that posts **confirmed** NHL trades, waiver moves and signings to the channels that subscribe to each team. It runs on **Cloudflare Workers** with a **D1** database, so it costs nothing on the free tier and needs no server.

- **Confirmed only.** Posts come only from trusted insiders (Friedman, LeBrun, …) or official NHL and team sources, and only when the wording describes a completed move.
- **No duplicates.** Deduplication happens at three levels: source item, real-world event, and channel.
- **Per-channel team subscriptions.** Each channel can follow specific teams.

## Status

| Milestone | State |
|---|---|
| 1. Skeleton: Worker, D1 schema, `/ping` | ✅ Done |
| 2. `/subscribe`, `/unsubscribe`, `/subscriptions` | ✅ Done |
| 3. Reddit source | ✅ Done |
| 4. Confirmed-only filter + classifier tests | ✅ Done |
| 5. Dedupe + posting embeds, `/replay` | ✅ Done |
| 6. Hardening (first-run backfill ✅, Reddit rate limits ✅, more sources) | ⏳ Next |
| 7. Daily games and broadcasts: `/games`, morning post | ✅ Done |

## Commands

| Command | Who can use it | What it does |
|---|---|---|
| `/subscribe team:<team> [trades] [waivers] [signings] [games]` | Manage Server | Follow a team in this channel. Pick **⭐ All teams** to follow the whole league. Set a type to `False` to skip it; for example, `/subscribe team:Leafs waivers:False` posts only trades and signings. `games:True` adds a morning post of the day's games and where they're on TV (off by default). Running it again for the same team updates its types. |
| `/unsubscribe team:<team>` | Manage Server | Stop following a team. Autocomplete lists only this channel's teams, plus **Remove all**. |
| `/subscriptions` | Everyone | List what this channel follows. |
| `/replay post:<link>` | Manage Server | Run an r/hockey post through the filter. If it's a confirmed move, post it to this server's subscribed channels (even if it's old), otherwise say why not. Handy for testing a new channel. |
| `/games [day] [team]` | Everyone | A day's games (today by default) with start times in your time zone and the US/Canadian TV networks. Visible to the whole channel. Also works in DMs. |
| `/ping` | Everyone | Check the bot is online. |

Subscriptions belong to a **channel**, so one server can have `#leafs-news` following Toronto and `#league-wide` following all teams. Replies are visible only to the person who ran the command. Server admins can change who is allowed to use each command in **Server Settings → Integrations**.

## How it works

```
Cron (every 2 min) ──► scheduled()  → fetch r/hockey → filter → dedupe → post
Cron (daily 15:00Z) ──► scheduled()  → NHL schedule → post today's games to subscribed channels
Discord command    ──► fetch() /interactions → verify signature → handle
```

Every 2 minutes the Worker reads the newest 100 posts on r/hockey through its RSS feed. Reddit blocks its JSON API from Workers, and the RSS rate limit is shared across Cloudflare's IPs, so a `429` is expected now and then; the next run catches up. The very first run only marks the existing posts as seen, so a new install doesn't post a backlog, and posts older than 6 hours are never posted.

### What counts as confirmed

A post is posted only if **all** of these hold (see [`src/news/classify.ts`](src/news/classify.ts) and its tests, which use real r/hockey titles):

1. **Trusted source:** a `[Tag]` naming a trusted insider (Friedman, LeBrun, Johnston, Dreger, McKenzie, Seravalli, Kaplan, PuckPedia, NHL PR) or a team, or a link to nhl.com or to one of those insiders' tweets.
2. **No hedging** up to the sentence that states the move: "not a done deal", "closing in", "nearing", "expected", "talks", "rework", questions, and so on.
3. **Completed-move wording:** *acquired*, *traded*, *in exchange for*, the `Team: players / Team: players` format (trades); *claimed off waivers*, *placed on waivers* (waivers); *signed*, *agreed to terms*, *extension* (signings).
4. **An NHL team** is named (or is in the nhl.com link), and it's a player move: coaches, GMs, PTOs and AHL/KHL contracts are skipped.

For the Knies–Marchenko trade, LeBrun's "proposed … not a done deal yet" and Friedman's "rework the trade" were skipped, and Friedman's `Columbus: Knies, Lorentz, Andrae and a 2nd / Tor: Marchenko, Miles Wood, Merzlikins` was posted.

### No duplicates

1. **Source item:** each Reddit post is processed once.
2. **Event:** later reports of the same move within 48 hours (same two teams in a trade; same team and player for waivers and signings) are recognized as the same event.
3. **Channel:** an event is posted to a channel at most once. If a run dies partway through posting, the next run finishes only the channels that are missing.

### Daily games

Channels that subscribe with `games:True` get the day's games every morning at 15:00 UTC (11 am Eastern in summer, 10 am in winter). A channel following ⭐ All teams gets the whole slate; one following specific teams gets only their games, and nothing on days they don't play. The schedule comes from NHL.com's public API, which groups games by Eastern date, so a 10 pm Pacific game is part of "today" even though it starts after midnight UTC.

Each line has the start time (a Discord timestamp, so everyone sees their own time zone), the matchup linking to NHL.com's Game Center, national networks for the US and Canada, and up to three regional networks. A `daily_posts` row per day and channel means a rerun never posts twice, and if NHL.com is down at 15:00 the 2-minute cron retries until 18:00 UTC.

## Setup

Infrastructure is Terraform in [`infra/`](infra/): the D1 database, the Worker with its bindings and secrets, the cron trigger and the workers.dev route. [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs it. Pull requests get tests and a `terraform plan` in the run summary. Pushes to `main` also apply D1 migrations, run `terraform apply` and register the slash commands.

### 1. Create the Discord application
1. Go to https://discord.com/developers/applications and select **New Application**.
2. From **General Information**, copy the **Application ID** and **Public Key**.
3. Under **Bot**, select **Reset Token** and copy the **bot token**.
4. Under **Installation**, add the scopes `bot` and `applications.commands` and the permissions **Send Messages**, **Embed Links** and **View Channels**. Then use the install link to add the bot to your server.

### 2. One-time Cloudflare bootstrap
Terraform keeps its state in R2, so the bucket has to exist before Terraform can run.
1. Enable R2 in the Cloudflare dashboard, then create the state bucket:
   ```bash
   npx wrangler r2 bucket create nhl-trade-tracker-tfstate
   ```
2. **R2 → Manage API tokens → Create API token** with **Object Read & Write** on `nhl-trade-tracker-tfstate`. Keep the **Access Key ID** and **Secret Access Key**.
3. **My Profile → API Tokens → Create Token** (custom) with these account permissions: **Workers Scripts: Edit**, **D1: Edit**. This is the token CI deploys with.

### 3. GitHub configuration
In **Settings → Secrets and variables → Actions**:

| Name | Kind | Value |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Secret | Token from step 2.3 |
| `R2_ACCESS_KEY_ID` | Secret | From step 2.2 |
| `R2_SECRET_ACCESS_KEY` | Secret | From step 2.2 |
| `DISCORD_BOT_TOKEN` | Secret | Bot token |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Cloudflare account ID |
| `DISCORD_APPLICATION_ID` | Variable | Application ID |
| `DISCORD_PUBLIC_KEY` | Variable | Public Key |
| `DISCORD_DEV_GUILD_ID` | Variable, optional | A server ID. Commands register there instantly instead of globally, which can take up to an hour. |

### 4. Deploy
Push to `main` or run the **Deploy** workflow by hand. The run summary prints the Interactions Endpoint URL. Paste it into the Discord developer portal under **General Information → Interactions Endpoint URL** and save. Discord sends a test request, and the bot answers it automatically. Then run `/ping` in Discord.

To run Terraform locally, export `CLOUDFLARE_API_TOKEN`, the R2 keys as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, and the `TF_VAR_*` values the workflow uses, then:
```bash
npm run build
cd infra
terraform init -backend-config='endpoints={s3="https://<account-id>.r2.cloudflarestorage.com"}'
terraform plan
```
Don't use `wrangler deploy`: Terraform owns the Worker and would overwrite it on the next apply.

## Development

```bash
npm test                  # unit tests
npm run typecheck
npm run db:migrate:local  # local D1
cp .dev.vars.example .dev.vars   # fill in the Discord values
npm run dev               # local Worker; trigger the cron with:
curl "http://localhost:8787/__scheduled?cron=*/2+*+*+*+*"
```

## Project layout

```
src/index.ts             Worker entry: fetch() for Discord, scheduled() for the cron
src/discord/verify.ts    Ed25519 request signature check
src/discord/commands.ts  Slash command definitions and handlers
src/data/teams.ts        All 32 teams with headline aliases, colours and lookup helpers
src/db/subscriptions.ts  Subscription reads and writes (D1)
src/db/events.ts         Seen items, events and posted messages (the three dedupe layers)
src/sources/reddit.ts    r/hockey RSS fetch and parse
src/news/classify.ts     Confirmed-only filter: source, wording, type, teams
src/news/pipeline.ts     Scan → classify → dedupe → post
src/news/embed.ts        The Discord embed for a move
src/discord/api.ts       Outgoing Discord REST calls
src/sources/nhl.ts       NHL.com schedule API: games, broadcasts, Eastern dates
src/games/format.ts      The schedule embed
src/games/daily.ts       The daily schedule post (once per day and channel, retried if NHL.com is down)
src/db/daily.ts          Which channels already got each day's schedule
migrations/              D1 schema
scripts/                 One-off tools (command registration)
infra/                   Terraform: D1, Worker, cron, workers.dev route
.github/workflows/       CI: test, plan, migrate, apply, register commands
test/                    Vitest tests (D1 is simulated with Node's built-in SQLite and the real migrations)
```
