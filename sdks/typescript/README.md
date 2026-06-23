# @opencomputer/sdk

The official TypeScript SDK for [OpenComputer](https://github.com/diggerhq/opensandbox): **cloud sandboxes** and **Durable Agent Sessions** (managed background agents).

> This one package covers both surfaces — install **`@opencomputer/sdk`**. (The older `@opencomputer/agents-sdk` is superseded; use this instead.)

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

## Durable Agent Sessions

Run a managed background agent: define an agent once, then create sessions that stream durable events and call back on completion.

```typescript
import { OpenComputer, verifyWebhook } from "@opencomputer/sdk";

const oc = new OpenComputer({ apiKey: process.env.OPENCOMPUTER_API_KEY! });

// Bootstrap once — idempotent by name (safe on every deploy):
const agent = await oc.agents.create({
  name: "reviewer",
  runtime: "claude",                       // or "codex"
  model: "anthropic/claude-opus-4-8",
  prompt: "Review the diff. Run tests. Explain risks.",
  key: process.env.ANTHROPIC_API_KEY!,     // sealed; never enters the sandbox
});

// Per request — hand off durable work, route the callback via metadata:
await oc.sessions.create({
  agent: agent.id,
  input: "Review PR #42",
  metadata: { pullNumber: 42 },            // echoed back verbatim in the webhook
  idempotencyKey: deliveryId,              // retry-safe
  destinations: [{ url: "https://app.example.com/oc-callback", secret: process.env.OC_WEBHOOK_SECRET! }],
});

// In your webhook handler — verify the signature, then fetch the result:
const delivery = await verifyWebhook(rawBody, request.headers, process.env.OC_WEBHOOK_SECRET!);
if (delivery.type === "turn.completed") {
  const session = await oc.sessions.get(delivery.sessionId);
  const { result } = await session.result();
}
```

## Configuration

| Option    | Env Variable            | Default                  |
|-----------|------------------------|--------------------------|
| `apiUrl`  | `OPENCOMPUTER_API_URL`  | `https://app.opencomputer.dev`  |
| `apiKey`  | `OPENCOMPUTER_API_KEY`  | (none)                   |

## License

MIT
