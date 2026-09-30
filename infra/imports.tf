# Adopts the database and Worker that were created by hand with wrangler
# before Terraform managed them. Once they are in state these are no-ops.
import {
  to = cloudflare_d1_database.main
  id = "${var.account_id}/2ec345c3-9173-476e-b2c0-c2b3b125f64d"
}

import {
  to = cloudflare_workers_script.bot
  id = "${var.account_id}/${var.worker_name}"
}

import {
  to = cloudflare_workers_cron_trigger.poll
  id = "${var.account_id}/${var.worker_name}"
}

import {
  to = cloudflare_workers_script_subdomain.bot
  id = "${var.account_id}/${var.worker_name}"
}
