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
