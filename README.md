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
| 3. Reddit source (dry-run logging) | ⏳ Next |
| 4. Confirmed-only filter + classifier tests | ⬜ |
| 5. Dedupe + posting embeds | ⬜ |
| 6. Hardening (first-run backfill, rate limits) | ⬜ |

## Commands

| Command | Who can use it | What it does |
|---|---|---|
| `/subscribe team:<team> [trades] [waivers] [signings]` | Manage Server | Follow a team in this channel. Pick **⭐ All teams** to follow the whole league. Set a type to `False` to skip it; for example, `/subscribe team:Leafs waivers:False` posts only trades and signings. Running it again for the same team updates its types. |
| `/unsubscribe team:<team>` | Manage Server | Stop following a team. Autocomplete lists only this channel's teams, plus **Remove all**. |
| `/subscriptions` | Everyone | List what this channel follows. |
| `/ping` | Everyone | Check the bot is online. |

Subscriptions belong to a **channel**, so one server can have `#leafs-news` following Toronto and `#league-wide` following all teams. Replies are visible only to the person who ran the command. Server admins can change who is allowed to use each command in **Server Settings → Integrations**.

## How it works

```
Cron (every 2 min) ──► scheduled()  → fetch news → filter → dedupe → post
Discord command    ──► fetch() /interactions → verify signature → handle
```

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
migrations/              D1 schema
scripts/                 One-off tools (command registration)
infra/                   Terraform: D1, Worker, cron, workers.dev route
.github/workflows/       CI: test, plan, migrate, apply, register commands
test/                    Vitest tests (D1 is simulated with Node's built-in SQLite and the real migrations)
```
