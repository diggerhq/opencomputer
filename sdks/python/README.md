# opencomputer

> **Deprecated.** `opencomputer-sdk` 1.2.0 is the final release; the package receives no further updates. It is a client for the OpenComputer sandbox platform, which is shut down. Importing `opencomputer` emits a `FutureWarning`.
>
> There is no Python replacement. For [Serverless Agents](https://opencomputer.dev/agents) call the [management API](https://opencomputer.dev/agents/api) over HTTP, or use the TypeScript client `@opencomputer/sdk/agents` (`npm install @opencomputer/sdk`). Pinning `opencomputer-sdk<1.2` avoids the warning.

Python SDK for [OpenComputer](https://github.com/diggerhq/opensandbox) — cloud sandbox platform.

## Install

```bash
pip install opencomputer-sdk
```

## Quick Start

```python
import asyncio
from opencomputer import Sandbox

async def main():
    sandbox = await Sandbox.create(template="base")

    # Execute commands
    result = await sandbox.commands.run("echo hello")
    print(result.stdout)  # "hello\n"

    # Read and write files
    await sandbox.files.write("/tmp/test.txt", "Hello, world!")
    content = await sandbox.files.read("/tmp/test.txt")

    # Clean up
    await sandbox.kill()
    await sandbox.close()

asyncio.run(main())
```

## Configuration

| Parameter  | Env Variable            | Default                 |
|------------|------------------------|-------------------------|
| `api_url`  | `OPENCOMPUTER_API_URL`  | `https://app.opencomputer.dev` |
| `api_key`  | `OPENCOMPUTER_API_KEY`  | (none)                  |

## License

MIT
