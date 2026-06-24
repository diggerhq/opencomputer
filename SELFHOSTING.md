# Self-hosting OpenComputer

This document describes the supported shape for running OpenComputer in your
own cloud account. OpenComputer is a control plane plus a fleet of bare-metal
worker machines that run real Linux VMs with QEMU/KVM. The same runtime can run
on Azure or AWS; the cloud-specific pieces are provisioning, VM image baking,
object storage, and secret loading.

Self-hosting is currently an operator path, not a one-command hosted product.
Expect to wire cloud resources, bake worker images, provide Postgres and Redis,
and run the server and worker services with the right `OPENSANDBOX_*`
configuration.

## Architecture

At runtime, clients talk to the OpenComputer server. The server owns API,
auth, sandbox routing, billing hooks, and autoscaling. Workers own VM reality:
they boot sandboxes, hibernate and wake them, serve command/file APIs, and talk
to the in-VM `osb-agent`.

```text
                  public or private API
                         |
                         v
+----------------+   HTTP/REST    +-----------------------+
| CLI / SDK / UI | -------------> | OpenComputer server   |
+----------------+                | cmd/server            |
                                  | internal/api          |
                                  +-----------+-----------+
                                              |
                                  worker RPC  |  autoscale
                                              v
                                  +-----------+-----------+
                                  | OpenComputer worker   |
                                  | cmd/worker            |
                                  | QEMU/KVM host         |
                                  +-----------+-----------+
                                              |
                                      vsock / serial
                                              v
                                  +-----------+-----------+
                                  | Sandbox VM            |
                                  | full Linux filesystem |
                                  | osb-agent             |
                                  +-----------------------+
```

A production self-hosted cell usually has these dependencies:

```text
                         +----------------------+
                         | DNS / HTTPS / auth   |
                         | optional dashboard   |
                         +----------+-----------+
                                    |
                                    v
+----------------+        +---------+----------+        +----------------+
| Postgres       | <----> | OpenComputer       | <----> | Redis          |
| sandbox state  |        | server             |        | coordination   |
+----------------+        +---------+----------+        +----------------+
                                    |
                                    | creates workers
                                    v
                         +----------+-----------+
                         | Cloud compute pool   |
                         | Azure VM or AWS EC2  |
                         +----------+-----------+
                                    |
                                    v
                         +----------+-----------+
                         | Worker nodes         |
                         | bare metal + KVM     |
                         +----------+-----------+
                                    |
                   checkpoints, hibernation, templates
                                    v
                         +----------+-----------+
                         | S3-compatible object |
                         | storage              |
                         +----------------------+
```

## What You Need

- A Linux host for the control plane, or equivalent service runner.
- Bare-metal worker instances with nested virtualization/KVM available.
- PostgreSQL for durable server state.
- Redis for worker coordination and runtime streams.
- S3-compatible object storage for checkpoints, hibernation archives,
  templates, and rootfs artifacts.
- A secrets backend, or environment variables managed by your deployment
  system.
- A worker VM image that contains QEMU, the OpenComputer worker binary, the
  in-VM agent assets, kernel/rootfs paths, and systemd service units.

OpenComputer uses historical `opensandbox` names in binaries and environment
variables. The product is OpenComputer; the binaries are `opensandbox-server`,
`opensandbox-worker`, and `osb-agent`; environment variables use the
`OPENSANDBOX_*` prefix.

## Provider Model

The server chooses a cloud compute pool through:

```text
OPENSANDBOX_COMPUTE_PROVIDER=azure
# or
OPENSANDBOX_COMPUTE_PROVIDER=aws
```

If the provider is not set, the server attempts to infer it from Azure or EC2
configuration. Set the provider explicitly for self-hosted deployments.

Cloud-specific code is intentionally narrow:

- `internal/compute/azure.go` launches and manages Azure worker VMs.
- `internal/compute/ec2.go` launches and manages AWS EC2 worker instances.
- `deploy/azure/` contains Azure provisioning scripts.
- `deploy/ec2/` and `deploy/terraform/` contain AWS dev-host and Terraform
  assets.
- `deploy/packer/worker-ami.pkr.hcl` and
  `deploy/packer/worker-ami-aws.pkr.hcl` build worker images.

Everything above the compute pool is cloud-neutral: HTTP APIs, sandbox state,
worker RPC, VM lifecycle, Postgres schema, Redis usage, and S3-compatible
storage access.

## Azure

Azure deployments use Azure VMs for the control plane and worker pool, Azure
Key Vault for shared secrets, Azure Blob Storage through the S3-compatible
storage abstraction where configured, and Azure managed identity for VM access
to cloud resources.

```text
Azure subscription
|
+-- Resource group
    |
    +-- VNet / subnet
    |   |
    |   +-- control plane VM
    |   |   +-- opensandbox-server
    |   |   +-- Postgres / Redis, or managed endpoints
    |   |
    |   +-- worker VM scale-out
    |       +-- opensandbox-worker
    |       +-- QEMU/KVM sandbox VMs
    |
    +-- Key Vault
    |   +-- server-* secrets
    |   +-- worker-* secrets
    |   +-- worker-image-id / worker-image-version
    |
    +-- Blob or S3-compatible object storage
        +-- checkpoints
        +-- hibernation archives
        +-- templates and rootfs artifacts
```

Start with these repo entry points:

- `deploy/azure/create-opencomputer-prod.sh` for a production-shaped Azure
  deployment script.
- `deploy/azure/create-azure-dev2.sh` for a dev cell example.
- `deploy/azure/bootstrap-worker-identity.sh` for the worker managed identity.
- `deploy/packer/worker-ami.pkr.hcl` for the Azure worker image bake.
- `deploy/server.env.example` and `deploy/worker.env.example` for service
  environment shape.

Core Azure server configuration:

```text
OPENSANDBOX_MODE=server
OPENSANDBOX_COMPUTE_PROVIDER=azure
OPENSANDBOX_SECRETS_PROVIDER=keyvault
OPENSANDBOX_REGION=<azure-region-or-normalized-cell-region>
OPENSANDBOX_CELL_ID=azure-<region>-<slot>
OPENSANDBOX_AZURE_SUBSCRIPTION_ID=<subscription-id>
OPENSANDBOX_AZURE_RESOURCE_GROUP=<resource-group>
OPENSANDBOX_AZURE_SUBNET_ID=<subnet-resource-id>
OPENSANDBOX_AZURE_VM_SIZE=<worker-vm-size>
OPENSANDBOX_AZURE_IMAGE_ID=<worker-image-id>
OPENSANDBOX_AZURE_KEY_VAULT_NAME=<vault-name>
OPENSANDBOX_AZURE_WORKER_IDENTITY_ID=<identity-resource-id>
```

Use Key Vault for secrets such as database URL, Redis URL, JWT signing secret,
object storage credentials, API keys, and optional observability tokens. The
secret-name to environment-variable mappings are implemented in
`internal/config/keyvault.go`.

## AWS

AWS deployments use EC2 for the control plane and worker pool, AWS Secrets
Manager for shared secrets, S3 for checkpoint and image artifacts, and IAM
instance profiles for resource access.

```text
AWS account
|
+-- VPC / subnet
|   |
|   +-- server EC2
|   |   +-- opensandbox-server
|   |   +-- optional ALB target
|   |
|   +-- worker EC2 pool
|       +-- bare-metal instance type
|       +-- opensandbox-worker
|       +-- QEMU/KVM sandbox VMs
|
+-- RDS PostgreSQL, or self-managed Postgres
+-- ElastiCache Redis, or self-managed Redis
+-- S3 bucket
|   +-- checkpoints
|   +-- hibernation archives
|   +-- templates and rootfs artifacts
|
+-- Secrets Manager
|   +-- server secret JSON
|   +-- worker secret JSON
|
+-- SSM Parameter Store
    +-- worker AMI id
    +-- worker AMI version
```

Start with these repo entry points:

- `deploy/ec2/README.md` for a personal end-to-end EC2 dev host.
- `deploy/ec2/deploy-qemu-dev.sh` for single-host AWS dev workflows.
- `deploy/ec2/setup-secrets.sh` for AWS Secrets Manager and IAM setup.
- `deploy/terraform/` for AWS VPC, security groups, RDS, Redis, ECR, server,
  worker, ALB, and dev-host modules.
- `deploy/packer/worker-ami-aws.pkr.hcl` for the AWS worker AMI bake.

Core AWS server configuration:

```text
OPENSANDBOX_MODE=server
OPENSANDBOX_COMPUTE_PROVIDER=aws
OPENSANDBOX_SECRETS_PROVIDER=secretsmanager
OPENSANDBOX_REGION=<aws-region>
OPENSANDBOX_CELL_ID=aws-<region>-<slot>
OPENSANDBOX_EC2_AMI=<worker-ami-id>
OPENSANDBOX_EC2_SSM_AMI_PARAM=<ssm-parameter-for-worker-ami>
OPENSANDBOX_EC2_INSTANCE_TYPE=<bare-metal-instance-type>
OPENSANDBOX_EC2_SUBNET_ID=<subnet-id>
OPENSANDBOX_EC2_SECURITY_GROUP_ID=<security-group-id>
OPENSANDBOX_EC2_IAM_INSTANCE_PROFILE=<instance-profile-name>
OPENSANDBOX_SECRETS_ARN=<server-secret-arn>
```

The EC2 pool can use a direct AMI ID or resolve the current worker AMI from
SSM Parameter Store. Use Secrets Manager for secret values such as database
URL, Redis URL, JWT signing secret, S3 credentials, and optional observability
tokens. Environment variable loading for AWS secrets is implemented in
`internal/config/secretsmanager.go`.

## Single-host Dev Topology

For development and validation, one bare-metal EC2 host can run the server,
worker, Postgres, Redis, and QEMU sandboxes together. This is useful when you
need real VM behavior without building the full production topology.

```text
laptop
|
|  browser / SDK / CLI
v
+------------------------------------------------+
| EC2 bare-metal dev host                        |
|                                                |
|  opensandbox-server :8080                      |
|      |                                         |
|      +-- local Postgres :5432                  |
|      +-- local Redis :6379                     |
|      +-- opensandbox-worker                    |
|              |                                 |
|              +-- QEMU sandbox VMs              |
|                      |                         |
|                      +-- osb-agent             |
+------------------------------------------------+
```

Use `deploy/ec2/README.md` for this path.

## Cell IDs

Use cell IDs of the form:

```text
{cloud}-{region}-{slot}
```

Examples:

```text
azure-us-east-2-a
azure-us-west-2-b
aws-us-east-1-a
```

Use AWS-style hyphenated region names in the cell ID even for Azure. The Azure
native region can still be used where Azure CLI or ARM APIs require it.

## Storage

Workers need object storage for durable VM artifacts:

- checkpoints
- hibernation archives
- golden rootfs images
- templates
- file transfer artifacts where configured

Configure the S3-compatible storage variables on server and worker processes:

```text
OPENSANDBOX_S3_BUCKET=<bucket-or-container>
OPENSANDBOX_S3_REGION=<region>
OPENSANDBOX_S3_ENDPOINT=<endpoint>
OPENSANDBOX_S3_ACCESS_KEY_ID=<access-key>
OPENSANDBOX_S3_SECRET_ACCESS_KEY=<secret-key>
OPENSANDBOX_S3_FORCE_PATH_STYLE=<true-or-false>
```

If you run multiple cells, keep object naming and retention policies consistent
across cells. The code also supports global blob store settings for canonical
golden rootfs and template blobs; see `internal/config/config.go` and
`docs/multi-cloud.md`.

## Deployment Checklist

1. Pick a cloud provider and region.
2. Create network resources, security rules, and DNS.
3. Provision Postgres, Redis, object storage, and a secrets backend.
4. Build and publish the server and worker binaries or container images.
5. Bake a worker image with QEMU/KVM prerequisites and `osb-agent` assets.
6. Configure the server with `OPENSANDBOX_MODE=server` and the chosen compute
   provider.
7. Configure worker secrets and non-secret defaults for sandbox capacity,
   storage, domain routing, and observability.
8. Start the server and verify `/health`.
9. Create a sandbox through the API or SDK.
10. Run an exec command inside the sandbox to verify worker RPC, VM boot, and
    `osb-agent` connectivity.
11. Test checkpoint, hibernate, wake, and preview URL behavior before routing
    real traffic.

## Validation

After deployment, run a minimal smoke test:

```bash
curl -sf "$OPENCOMPUTER_URL/health"

SBX=$(curl -s -X POST "$OPENCOMPUTER_URL/api/sandboxes" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $OPENCOMPUTER_API_KEY" \
  -d '{"templateID":"default"}' | jq -r .sandboxID)

curl -s -X POST "$OPENCOMPUTER_URL/api/sandboxes/$SBX/exec" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $OPENCOMPUTER_API_KEY" \
  -d '{"cmd":"uname -a && pwd && date"}'
```

Successful output proves the public API, control plane, worker selection, VM
boot path, and in-VM agent are all connected.

## Related Docs

- `docs/multi-cloud.md` explains the internal provider abstraction.
- `deploy/ec2/README.md` documents the AWS single-host dev environment.
- `deploy/server.env.example` and `deploy/worker.env.example` show service
  environment files.
- `internal/config/config.go` is the source of truth for runtime
  configuration.
