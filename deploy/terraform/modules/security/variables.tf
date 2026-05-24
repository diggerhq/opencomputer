variable "project_name" {
  description = "Project name used as a prefix for resource naming"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod). Dev mode creates a single SG; any other value creates prod-style SGs."
  type        = string
}

variable "vpc_id" {
  description = "ID of the VPC in which to create security groups"
  type        = string
}

variable "vpc_cidr_block" {
  description = "CIDR block of the VPC, used for intra-VPC SSH access in prod mode"
  type        = string
}

variable "extra_ingress_ports" {
  description = <<-EOT
    Additional TCP ports to allow inbound on the dev security group, in
    addition to the always-on API (8080) and SSH (22). Useful if you run
    a sidecar service on the same host (e.g. an agent orchestrator on :3000
    or a metrics endpoint on :9090) and want it reachable without standing
    up a full prod-mode ALB. Each entry is opened to 0.0.0.0/0; tighten via
    the `extra_ingress_cidr` knob if you need a narrower source. Only
    consulted in dev mode (environment = "dev*"); no-op in prod mode.
  EOT
  type = list(object({
    port        = number
    description = string
  }))
  default = []
}

variable "extra_ingress_cidr" {
  description = "CIDR block for `extra_ingress_ports`. Defaults to 0.0.0.0/0 (public). Set to your office IP, a VPN CIDR, or a private subnet to scope down."
  type        = string
  default     = "0.0.0.0/0"
}
