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

## Streaming Commands

For long-running commands, use `stream()` to get real-time output instead of waiting for completion:

```typescript
// Callback style — get output as it arrives, await final result
const result = await sandbox.commands.stream("make build && make test", {
  timeout: 300,
  onStdout: (data) => process.stdout.write(data),
  onStderr: (data) => process.stderr.write(data),
});
console.log(`Exit code: ${result.exitCode}`);

// Async iterator — process chunks one at a time
for await (const chunk of sandbox.commands.stream("npm install")) {
  // chunk.stream is "stdout" or "stderr"
  process.stdout.write(chunk.data);
}
```

### `run()` vs `stream()`

| | `run()` | `stream()` |
|---|---|---|
| **Use case** | Short commands, scripting | Long builds, tailing logs, anything > ~30s |
| **Returns** | `ProcessResult` after completion | Async iterable of chunks, resolves to `ProcessResult` |
| **Output** | Buffered (stdout/stderr as strings) | Real-time chunks via SSE |
| **Timeout risk** | Yes, for long commands | No — SSE keeps the connection alive |

### StreamHandle

`stream()` returns a `StreamHandle` that is both:
- **`PromiseLike<ProcessResult>`** — await it to get the final result with accumulated stdout/stderr
- **`AsyncIterable<ExecChunk>`** — iterate over it to process chunks as they arrive

```typescript
// These are equivalent:
const result = await sandbox.commands.stream("echo hi");
// result.exitCode, result.stdout, result.stderr

// Or iterate:
const handle = sandbox.commands.stream("echo hi");
for await (const chunk of handle) {
  // { stream: "stdout", data: "hi\n" }
}
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
