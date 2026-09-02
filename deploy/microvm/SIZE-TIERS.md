# Offering a MicroVM size tier

Memory is the only sizing knob this platform has, and it lives on the **image**, not the launch:
`RunMicrovmInput` carries no memory or vCPU field. So a size tier *is* an image. Offering N
sizes means publishing N images and selecting one per create.

Nothing here is optional — a tier that is built but not configured is refused at create, and a
tier that is configured but not built fails at launch.

## Prerequisites (once per account/region)

| | |
|---|---|
| Build role | `arn:aws:iam::<acct>:role/opensandbox-microvm-build`, or override `MICROVM_BUILD_ROLE_ARN` |
| Base image | `arn:aws:lambda:<region>:aws:microvm-image:al2023-1`, or override `MICROVM_BASE_IMAGE_ARN` |
| Architecture | **ARM_64 only.** `build.sh` cross-compiles to match; `publish.sh` states it explicitly so the two cannot drift |
| S3 bucket | somewhere to put the artifact zip |
| AWS CLI | with `lambda-microvms` support |

## Per tier

Every tier is the **same artifact** published under a different name with a different memory
value. Build once, publish N times.

```bash
# 1. Package + upload the artifact (once, shared by every tier)
./deploy/microvm/build.sh                       # → s3://<bucket>/agent-image.zip

# 2. Publish one image per tier
MICROVM_IMAGE_NAME=opensandbox-agent-prod-8192 \
MICROVM_IMAGE_MEMORY_MB=8192 \
  ./deploy/microvm/publish.sh s3://<bucket>/agent-image.zip
```

`publish.sh` polls until the build leaves `CREATING` and prints `latestActiveImageVersion`.
A tier is not usable until that appears.

### Memory floor

`MICROVM_IMAGE_MEMORY_MB` defaults to **2048**, and the script warns below it:

> 2048 MiB is the smallest baseline that still gets a full vCPU under Lambda's baseline-peak
> model, and peak scales to 4x it. Keep that as the floor — below it a box may not get a full
> vCPU, and there is no way to ask for one.

512 and 1024 tiers are publishable but should be treated as unsupported: CPU is allocated as a
function of memory, so a sub-2048 tier may not get a full vCPU and nothing can compensate.

### Naming

**Name images per environment.** Dev and prod share an AWS account, and the image ARN is the
only ownership signal anything has. `opensandbox-agent-dev-8192` and `opensandbox-agent-prod-8192`
must be distinct images, or one environment's tooling can act on the other's boxes.

## Wiring the cell

Publishing an image does nothing on its own. The cell has to be told about it:

```bash
# /etc/opensandbox/server.env
OPENSANDBOX_MICROVM_IMAGE_ARN=arn:aws:lambda:us-east-1:<acct>:microvm-image:opensandbox-agent-prod
OPENSANDBOX_MICROVM_DEFAULT_MEMORY_MB=4096
OPENSANDBOX_MICROVM_SIZE_IMAGES="2048=arn:...:opensandbox-agent-prod-2048,8192=arn:...:opensandbox-agent-prod-8192"
```

Then restart the control plane — the config is read at startup.

- `IMAGE_ARN` is the **default** tier, and the only one the warm pool stocks.
- `SIZE_IMAGES` is every **other** tier, `mb=arn` comma-separated. A tier absent from this map
  is refused at create, never silently served from the default image.
- A malformed entry is dropped with a log line rather than failing startup. That tier then
  refuses instead of becoming a wrong-size sandbox — so **check the logs**, a typo is silent
  apart from that line.

### DEFAULT_MEMORY_MB must match the image

`OPENSANDBOX_MICROVM_DEFAULT_MEMORY_MB` must equal the default image's actual
`minimumMemoryInMiB`. It is what metering reads:

> if it drifts from the image, every sandbox on that image is billed for the wrong size

Left at 0 it falls back to a built-in baseline of 4096. If you publish the default image at any
other size, set this explicitly.

## Verifying

On startup the control plane logs the tiers it will serve:

```
microvm: size tiers — default 4096MB pooled, cold-only: [2048 8192]
```

Then confirm end to end — an unconfigured tier must be refused, not downsized:

```bash
# a configured tier → 201
curl -X POST "$API/api/sandboxes" -H "X-API-Key: $KEY" -d '{"memoryMB":8192}'

# an unconfigured one → 400, listing what IS offered
curl -X POST "$API/api/sandboxes" -H "X-API-Key: $KEY" -d '{"memoryMB":3072}'
# {"error":"requested sandbox size is not available in this region: 3072MB was requested;
#           this region offers 4096 MB, 2048, 8192"}
```

## Costs of a non-default tier

Only the default tier is pooled. Warm stock is per-image, so pooling every tier would either
multiply idle spend by the number of tiers or split one pool between them and lose the latency
the pool exists for.

A non-default tier therefore **cold-launches (~3s)** rather than being claimed from the pool.
That is the deliberate trade: one size is fast, the rest are correct.
