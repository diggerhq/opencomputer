# OpenComputer

**Cloud sandboxes for AI agents.** Each sandbox is a full Linux VM in the cloud — its own kernel, filesystem, network, and process space, isolated with hardware-level virtualization via KVM. Write files, install packages, run commands, and build complete projects inside secure, disposable environments that boot in milliseconds and sleep when idle.

```typescript
import { Sandbox } from "@opencomputer/sdk";

const sandbox = await Sandbox.create();
const result = await sandbox.exec.run("echo Hello from $(uname -a)");
console.log(result.stdout);
await sandbox.kill();
```

[Documentation](https://docs.opencomputer.dev) · [Quickstart](https://docs.opencomputer.dev/quickstart) · [Dashboard](https://app.opencomputer.dev)

## Why OpenComputer

- **Full Linux VMs, not containers.** Real kernel, real memory, real disk. Hardware-level isolation via KVM.
- **Long-running.** Sandboxes live for hours or days, not minutes. Install packages, build projects, run test suites, iterate — no cold starts between steps. A rolling idle timeout hibernates them when you stop using them.
- **Checkpoint and fork.** Named snapshots you can branch from — like git branches for VMs. Try five approaches in parallel from the same starting point.
- **Elastic compute.** Scale memory and CPU at runtime. Request more resources for heavy tasks and release them after.
- **Hibernate and wake.** Idle sandboxes snapshot their state and stop costing compute. Waking restores them in seconds, and preview URLs wake them on demand.

## Install

```bash
npm install @opencomputer/sdk        # TypeScript SDK

# CLI (installs to ~/.local/bin, no sudo)
curl -fsSL https://raw.githubusercontent.com/diggerhq/opencomputer/main/scripts/install.sh | bash
```

```bash
export OPENCOMPUTER_API_KEY=your-api-key
```

Grab your API key from [app.opencomputer.dev](https://app.opencomputer.dev).

## Checkpoint and fork

Set up an environment once, snapshot it, and fork independent copies — each fork is a fully isolated VM starting from the same state:

```typescript
import { Sandbox } from "@opencomputer/sdk";

const sandbox = await Sandbox.create();
await sandbox.exec.run("npm install && npm run build", { cwd: "/app" });

// Checkpoint after setup
const cp = await sandbox.createCheckpoint("after-build");

// Fork two independent sandboxes from it
const a = await Sandbox.createFromCheckpoint(cp.id);
const b = await Sandbox.createFromCheckpoint(cp.id);

await a.exec.run("npm run test:unit", { cwd: "/app" });
await b.exec.run("npm run test:e2e", { cwd: "/app" });
```

## Everything a machine can do

- **Commands** — one-off runs or persistent exec sessions, with streaming output ([docs](https://docs.opencomputer.dev/sandboxes/running-commands))
- **Files** — read, write, list, and transfer files; signed upload/download URLs for large artifacts ([docs](https://docs.opencomputer.dev/sandboxes/working-with-files))
- **Interactive terminals** — real PTY sessions for shells and TUIs ([docs](https://docs.opencomputer.dev/sandboxes/interactive-terminals))
- **Preview URLs** — expose any port on a public HTTPS URL, with optional auth and custom domains ([docs](https://docs.opencomputer.dev/sandboxes/preview-urls))
- **Custom templates** — define your environment declaratively and boot from pre-built snapshots ([docs](https://docs.opencomputer.dev/sandboxes/templates))
- **Secrets** — encrypted secret stores with egress allowlists, resolved inside the VM ([docs](https://docs.opencomputer.dev/sandboxes/secrets))
- **Webhooks** — signed, retried lifecycle events for boots, hibernation, stops, and scaling ([docs](https://docs.opencomputer.dev/sandboxes/webhooks))

## CLI

The `oc` CLI manages sandboxes from your terminal:

```bash
oc login

oc create --timeout 600                        # create a sandbox
oc exec sb-abc123 --wait -- echo "hello"       # run a command
oc shell sb-abc123                             # interactive terminal
oc checkpoint create sb-abc123 --name after-setup
oc preview create sb-abc123 --port 3000        # public HTTPS URL
```

See the [CLI docs](https://docs.opencomputer.dev/cli/overview) for the full command set.

## Self-hosting

OpenComputer is a control plane plus a fleet of bare-metal workers running real VMs with QEMU/KVM, and you can run it in your own cloud account. See [SELFHOSTING.md](./SELFHOSTING.md).

## Get started

Follow the [quickstart](https://docs.opencomputer.dev/quickstart) to create your first sandbox in two minutes.
