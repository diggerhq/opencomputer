# opencomputer

Python SDK for [OpenComputer](https://github.com/diggerhq/opensandbox) — cloud sandbox platform.

## Install

```bash
pip install opencomputer
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

## Streaming Commands

For long-running commands, use `stream()` to get real-time output instead of waiting for completion:

```python
import asyncio
import sys
from opencomputer import Sandbox

async def main():
    sandbox = await Sandbox.create(template="base")

    # Callback style — get output as it arrives, await final result
    result = await sandbox.commands.stream(
        "make build && make test",
        timeout=300,
        on_stdout=lambda data: print(data, end=""),
        on_stderr=lambda data: print(data, end="", file=sys.stderr),
    )
    print(f"Exit code: {result.exit_code}")

    # Async iterator — process chunks one at a time
    async for chunk in sandbox.commands.stream_iter("npm install"):
        # chunk.stream is "stdout" or "stderr"
        print(chunk.data, end="")

    await sandbox.kill()
    await sandbox.close()

asyncio.run(main())
```

### `run()` vs `stream()`

| | `run()` | `stream()` |
|---|---|---|
| **Use case** | Short commands, scripting | Long builds, tailing logs, anything > ~30s |
| **Returns** | `ProcessResult` after completion | `ProcessResult` with real-time callbacks |
| **Output** | Buffered (stdout/stderr as strings) | Real-time chunks via SSE |
| **Timeout risk** | Yes, for long commands | No — SSE keeps the connection alive |

### Methods

- **`stream(command, on_stdout=..., on_stderr=...)`** — Execute with callbacks, returns `ProcessResult` when done
- **`stream_iter(command)`** — Execute as an async iterator, yields `ExecChunk` objects

```python
# ExecChunk has two fields:
# chunk.stream — "stdout" or "stderr"
# chunk.data   — the output text
```

## PTY (Terminal)

Open an interactive pseudo-terminal session:

```python
session = await sandbox.pty.create(
    cols=120,
    rows=40,
    on_output=lambda data: sys.stdout.buffer.write(data),
)

await session.send("ls -la\n")
data = await session.recv()
await session.close()
```

## Configuration

| Parameter  | Env Variable            | Default                 |
|------------|------------------------|-------------------------|
| `api_url`  | `OPENCOMPUTER_API_URL`  | `https://app.opencomputer.dev` |
| `api_key`  | `OPENCOMPUTER_API_KEY`  | (none)                  |

## License

MIT
