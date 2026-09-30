variable "account_id" {
  description = "Cloudflare account ID."
  type        = string
}

variable "worker_name" {
  description = "Worker script name. Also the workers.dev hostname prefix."
  type        = string
  default     = "nhl-trade-tracker"
}

variable "workers_subdomain" {
  description = "The account's workers.dev subdomain (Workers & Pages → Settings in the dashboard)."
  type        = string
  default     = "graniero-jonathan"
}

variable "database_name" {
  description = "D1 database name. Must match database_name in wrangler.toml."
  type        = string
  default     = "nhl-trade-tracker"
}

variable "compatibility_date" {
  description = "Workers runtime compatibility date. Keep in sync with wrangler.toml (used by wrangler dev)."
  type        = string
  default     = "2025-09-01"
}

variable "cron_schedules" {
  description = "Cron expressions that trigger scheduled()."
  type        = list(string)
  default     = ["*/2 * * * *"] # poll for news every 2 minutes
}

variable "worker_bundle" {
  description = "Path to the bundled Worker, produced by: npm run build"
  type        = string
  default     = "../dist/index.js"
}

variable "discord_application_id" {
  type = string
}

variable "discord_public_key" {
  type = string
}

variable "discord_bot_token" {
  type      = string
  sensitive = true
}
