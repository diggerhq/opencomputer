# VM ↔ Durable Object TTI proof of concept

This isolated development Worker measures the floor of the proposed warm-pool
path without changing the normal OpenComputer API deployment:

```text
ComputeSDK -> Worker -> deterministic per-VM DO -> persistent WebSocket -> VM process
```

The public endpoints intentionally implement the subset of the OpenComputer API
used by the ComputeSDK TTI benchmark:

- `POST /api/sandboxes`
- `GET|DELETE /api/sandboxes/:id`
- `POST /api/sandboxes/:id/exec/run-async`

`create` models an already-successful lease of the configured VM; delete is a no-op. This
is deliberately a one-VM floor test, not a pool allocator or production sandbox
lifecycle implementation.

## IAD to East US 2 result

The isolated production dry run completed on 2026-08-03 with this topology:

```text
AWS us-east-1 client (Cloudflare ingress IAD)
  -> Cloudflare Worker
  -> Durable Object verified in IAD
  -> persistent protobuf WebSocket
  -> running OpenComputer VM in Azure East US 2
  -> node -v
```

The client used Node 24 and `@computesdk/opencomputer@1.0.1`. A reporting-only
wrapper imported and invoked the upstream ComputeSDK benchmark's unchanged
`config` and `task`, because the upstream runner requires a separate
`BENCHMARKS_PLATFORM_API_KEY` before it will execute locally. The workload was
therefore still exactly `sandbox.create()` followed by
`sandbox.runCommand("node -v")`; destroy remained outside TTI.

### Upstream ComputeSDK task, 100 sequential iterations

| Measurement | Minimum | Median | P95 | P99 | Mean |
| --- | ---: | ---: | ---: | ---: | ---: |
| TTI | 36.15 ms | 44.56 ms | 49.37 ms | 142.94 ms | 47.57 ms |
| Create | 10.08 ms | 15.65 ms | 18.86 ms | 25.40 ms | 17.20 ms |
| Execute | 26.06 ms | 28.94 ms | 32.73 ms | 55.02 ms | 30.37 ms |

All 100 iterations succeeded against the real VM. The TTI maximum was
213.45 ms. A prior invalid run made while the VM was hibernated was discarded;
the successful run started only after the DO lease probe reported
`connected: true`.

### Direct stage probe, 100 sequential iterations

| Measurement | Minimum | Median | P95 |
| --- | ---: | ---: | ---: |
| Total create + execute | 33.93 ms | 39.72 ms | 46.43 ms |
| Create client round trip | 8.67 ms | 12.01 ms | 14.76 ms |
| Execute client round trip | 24.29 ms | 27.60 ms | 32.24 ms |
| Time inside Durable Object | 11 ms | 12 ms | 15 ms |
| VM `node -v` process | 4 ms | 4 ms | 4 ms |

The create handler itself took less than 1 ms at the edge and rounded to
0 ms. The 12.01 ms create median is therefore primarily the warm client-to-IAD
Worker request/response. It does **not** include a D1 allocation transaction:
this POC returns the statically configured, pre-leased VM. A production pool
allocator must add and measure the real lease operation before treating this as
an end-to-end production result.

The observed floor was 33.93-36.15 ms depending on whether the direct probe or
the full ComputeSDK adapter path was measured. The practical steady-state
median was 39.72-44.56 ms.

The VM opens the connection to the DO. Commands and results use the protobuf
schema in `protocol/exec.proto`. The POC uses small dependency-free,
generated-style codecs so neither endpoint pays for a general protobuf runtime;
the bytes remain compatible with standard protobuf tooling.

## Development deployment

This config can only route the isolated custom hostname
`vm-do-poc.mo-oc-dev.com` in the personal development account.

Set `BENCH_API_TOKEN` and `VM_CONNECT_SECRET` as Wrangler secrets, deploy, then
run `vm-agent.mjs` inside the warm development VM. `provision-vm.mjs` creates a
normal mo-oc-dev sandbox, uploads the agent, starts it in the background, and
waits for the DO connection. The equivalent command inside the VM is:

```bash
OC_DO_URL=wss://vm-do-poc.mo-oc-dev.com/internal/vms/vm-seoul-1/connect \
OC_DO_VM_SECRET=... node vm-agent.mjs
```

Run the existing unmodified ComputeSDK benchmark against the POC URL:

```bash
OPENCOMPUTER_API_URL=https://vm-do-poc.mo-oc-dev.com \
OPENCOMPUTER_API_KEY=... \
node ../../benchmarks/tti/bench.mjs --mode sequential --iterations 20
```
