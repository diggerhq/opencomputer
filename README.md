# OpenComputer

OpenComputer provides full Linux virtual machines in the cloud for running AI applications and untrusted code. Sandboxes start quickly, keep their filesystem between commands, hibernate when idle, and can be checkpointed, restored, and forked.

```bash
# Install the CLI
curl -fsSL https://raw.githubusercontent.com/diggerhq/opencomputer/main/scripts/install.sh | bash

# Authenticate, create a sandbox, and run a command
oc auth login
oc sandbox create
oc exec <sandbox-id> -- uname -a
```

[Documentation](https://docs.opencomputer.dev/introduction) · [Quickstart](https://docs.opencomputer.dev/quickstart) · [Dashboard](https://app.opencomputer.dev)

## SDKs

Create and control sandboxes from TypeScript or Python:

```bash
npm install @opencomputer/sdk
pip install opencomputer-sdk
```

```typescript
import { Sandbox } from "@opencomputer/sdk";

const sandbox = await Sandbox.create();
const result = await sandbox.commands.run("echo 'Hello from OpenComputer'");
console.log(result.stdout);
await sandbox.kill();
```

```python
import asyncio
from opencomputer import Sandbox

async def main():
    sandbox = await Sandbox.create()
    result = await sandbox.commands.run("echo 'Hello from OpenComputer'")
    print(result.stdout)
    await sandbox.kill()

asyncio.run(main())
```

## Sandbox capabilities

- Full Linux VMs with hardware-level isolation
- Persistent filesystems and configurable idle timeouts
- Checkpoints, restores, and forks
- Runtime CPU and memory scaling
- Interactive terminals and command execution
- File transfer, secrets, and HTTPS preview URLs
- TypeScript and Python SDKs plus the `oc` CLI

See the [sandbox overview](https://docs.opencomputer.dev/sandboxes/overview) for the complete lifecycle and API.
