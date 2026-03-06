# @opencomputer/sdk

TypeScript SDK for [OpenComputer](https://github.com/diggerhq/opensandbox) — cloud sandbox platform.

## Install

```bash
npm install @opencomputer/sdk
```

## Quick Start

```typescript
import { Sandbox } from "@opencomputer/sdk";

const sandbox = await Sandbox.create({ template: "base" });

// Execute commands
const result = await sandbox.commands.run("echo hello");
console.log(result.stdout); // "hello\n"

// Read and write files
await sandbox.files.write("/tmp/test.txt", "Hello, world!");
const content = await sandbox.files.read("/tmp/test.txt");

// Clean up
await sandbox.kill();
```

## Streaming Output

For long-running commands, pass `onStdout`/`onStderr` callbacks to get real-time output:

```typescript
const result = await sandbox.commands.run("make build && make test", {
  timeout: 300,
  onStdout: (data) => process.stdout.write(data),
  onStderr: (data) => process.stderr.write(data),
});
console.log(`Exit code: ${result.exitCode}`);
```

Use `tty: true` for programs that buffer output when not connected to a terminal (npm, apt, pip):

```typescript
await sandbox.commands.run("npm install", {
  tty: true,
  onStdout: (data) => process.stdout.write(data),
});
```

## Background Processes

Start long-running processes (servers, watchers) that keep running in the sandbox:

```typescript
// Start a server in the background — returns immediately
const handle = await sandbox.commands.run("python manage.py runserver 0.0.0.0:8000", {
  background: true,
  onStdout: (data) => console.log(data),
});

// handle.sessionId — for reconnection
// handle.sendInput("quit\n") — send stdin
// handle.disconnect() — detach without killing
// handle.kill() — terminate the process
// handle.wait() — wait for process to exit

// Reconnect to a running process later
const handle2 = await sandbox.commands.connect(handle.sessionId);

// Kill by session ID
await sandbox.commands.kill(handle.sessionId);
```

## PTY (Terminal)

Open an interactive pseudo-terminal session:

```typescript
const session = await sandbox.pty.create({
  cols: 120,
  rows: 40,
  onOutput: (data) => process.stdout.write(data),
  onClose: () => console.log("session ended"),
});

session.send("ls -la\n");
await session.resize(200, 50);
session.close();
```

## Configuration

| Option    | Env Variable            | Default                  |
|-----------|------------------------|--------------------------|
| `apiUrl`  | `OPENCOMPUTER_API_URL`  | `https://app.opencomputer.dev`  |
| `apiKey`  | `OPENCOMPUTER_API_KEY`  | (none)                   |

## License

MIT
