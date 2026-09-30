output "database_id" {
  value = cloudflare_d1_database.main.id
}

output "worker_url" {
  value = "https://${var.worker_name}.${var.workers_subdomain}.workers.dev"
}

output "interactions_endpoint_url" {
  description = "Paste into the Discord developer portal as the Interactions Endpoint URL."
  value       = "https://${var.worker_name}.${var.workers_subdomain}.workers.dev/interactions"
}
