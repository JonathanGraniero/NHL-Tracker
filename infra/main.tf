resource "cloudflare_d1_database" "main" {
  account_id = var.account_id
  name       = var.database_name

  read_replication = {
    mode = "disabled"
  }

  # Recreating the database would wipe every subscription.
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_workers_script" "bot" {
  account_id         = var.account_id
  script_name        = var.worker_name
  main_module        = "index.js"
  content_file       = var.worker_bundle
  content_sha256     = filesha256(var.worker_bundle)
  compatibility_date = var.compatibility_date

  bindings = [
    {
      name = "DB"
      type = "d1"
      id   = cloudflare_d1_database.main.id
    },
    {
      name = "DISCORD_APPLICATION_ID"
      type = "plain_text"
      text = var.discord_application_id
    },
    {
      name = "DISCORD_PUBLIC_KEY"
      type = "plain_text"
      text = var.discord_public_key
    },
    {
      name = "DISCORD_BOT_TOKEN"
      type = "secret_text"
      text = var.discord_bot_token
    },
  ]

  observability = {
    enabled = true
    logs = {
      enabled         = true
      invocation_logs = true
    }
  }
}

resource "cloudflare_workers_cron_trigger" "poll" {
  account_id  = var.account_id
  script_name = cloudflare_workers_script.bot.script_name
  schedules   = [for cron in var.cron_schedules : { cron = cron }]
}

resource "cloudflare_workers_script_subdomain" "bot" {
  account_id  = var.account_id
  script_name = cloudflare_workers_script.bot.script_name
  enabled     = true
}
