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

## Streaming Output

For long-running commands, pass `on_stdout`/`on_stderr` callbacks:

```python
result = await sandbox.commands.run(
    "make build && make test",
    timeout=300,
    on_stdout=lambda data: print(data, end=""),
    on_stderr=lambda data: print(data, end="", file=sys.stderr),
)
print(f"Exit code: {result.exit_code}")
```

Use `tty=True` for programs that buffer output without a terminal:

```python
await sandbox.commands.run("npm install", tty=True, on_stdout=print)
```

## Background Processes

Start long-running processes that keep running in the sandbox:

```python
# Start a server in the background — returns immediately
handle = await sandbox.commands.run(
    "python manage.py runserver 0.0.0.0:8000",
    background=True,
)

# handle.session_id — for reconnection
# await handle.kill() — terminate the process

# Reconnect later
handle2 = await sandbox.commands.connect(handle.session_id)

# Kill by session ID
await sandbox.commands.kill(handle.session_id)
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
