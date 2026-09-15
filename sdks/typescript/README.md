# @opencomputer/sdk

The official TypeScript SDK for [OpenComputer](https://github.com/diggerhq/opencomputer): the **cloud sandbox** client at the package root, and the **Serverless Agents** management client on the portable `@opencomputer/sdk/managed-agents` subpath.

> Versions before 2.0.0 also carried a client for the retired Durable Agent Sessions API; see [CHANGELOG](./CHANGELOG.md).

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

## Serverless Agents management client

Serverless Agents (`opencomputer deploy`) are managed over the [management API](https://opencomputer.dev/agents/api). The client for it is a separate subpath export whose module graph has no Node dependency and runs nothing at import, so the same code serves a Cloudflare Worker without Node compatibility, Vercel, Deno and Node. Use it from trusted server code; the API key must not reach a browser.

```typescript
import { OpenComputer, OpenComputerError } from "@opencomputer/sdk/managed-agents";

const oc = new OpenComputer({ apiKey: process.env.OPENCOMPUTER_API_KEY! });

// Create a session, then admit its first turn; one key per call makes a retry safe.
const { session } = await oc.sessions.create(
  { agentId: "worker@development", labels: { request: taskId } },
  { idempotencyKey: taskId },
);
const receipt = await oc.sessions.turns.send(session.id, {
  input: "Review the pull request.",
  idempotencyKey: `${taskId}/start`,
});

// Follow the durable event log from a cursor.
const events = await oc.sessions.events.list(session.id, { after: 0 });

// List rows, filtered and paged.
const page = await oc.sessions.list({ environment: "development", limit: 20 });

try {
  await oc.sessions.get("missing");
} catch (error) {
  if (error instanceof OpenComputerError) console.log(error.code, error.status, error.message);
}
```

The method tree mirrors the API one to one: `sessions.create|get|list|end|interrupt|setLabels|startOnDocument`, `sessions.turns.send`, `sessions.events.list`, `projects.list|get|create`, `projects.memory`, `projects.webhooks`, `projects.eventSubscriptions`, `projects.github.repositories`, `agents.list`, `deployments.get|list`. Every failed call throws `OpenComputerError` with `{ code, status, message }`.

### Start a session on a memory document

Applications that keep notes in [memory](https://opencomputer.dev/agents/memory) open a topic as "these notes, this session". `oc.sessions.startOnDocument` creates the document if it is new, then a session bound to it, both converging under one key on retry:

```typescript
const { document, session } = await oc.sessions.startOnDocument({
  projectId: "prj_…", environment: "development", agent: "topic-worker",
  resource: "topics", documentId: "workshop", document: { title: "Workshop" },
  idempotencyKey: `topic/workshop/${deploymentId}`,
});
// document.created, session.created: false when they already existed.
```

`startSessionOnDocument({ apiKey, ...params })` from the same subpath is the standalone form of the call.

## Sandbox webhooks (Preview)

Subscribe to sandbox lifecycle events (`sandbox.ready`, `sandbox.stopped`, …) — signed, retried, and redeliverable. `verifyWebhook` checks a delivery's signature and returns its envelope. **Preview: newly available; the surface may change.**

```typescript
import { Webhooks, verifyWebhook, type SandboxLifecycleEvent } from "@opencomputer/sdk";

const webhooks = new Webhooks({ apiKey: process.env.OPENCOMPUTER_API_KEY! });

// `secret` (whsec_…) is returned ONCE on create — store it; you need it to verify.
const { secret } = await webhooks.create({
  url: "https://app.example.com/oc-webhook",
  eventTypes: ["sandbox.stopped"],
});

// In your handler — verify against the RAW body, then route:
const delivery = await verifyWebhook<SandboxLifecycleEvent>(rawBody, request.headers, secret);
if (delivery.type === "sandbox.stopped") {
  console.log(delivery.sandboxId, delivery.event.data.reason);
}
```

## Configuration

**Sandboxes** (`Sandbox`):

| Option   | Env Variable           | Default                          |
|----------|------------------------|----------------------------------|
| `apiUrl` | `OPENCOMPUTER_API_URL` | `https://app.opencomputer.dev`   |
| `apiKey` | `OPENCOMPUTER_API_KEY` | (none)                           |

**Serverless Agents** (`OpenComputer` from `@opencomputer/sdk/managed-agents`):

| Option    | Default                                            |
|-----------|----------------------------------------------------|
| `baseUrl` | `https://app.opencomputer.dev/api/managed-agents`  |
| `apiKey`  | required                                           |
| `fetch`   | the global `fetch`                                 |

Importing the package root installs nothing globally and opens no connection. The sandbox client keeps its own HTTP/2 pool, created on the first request and warmed on the first `Sandbox.create`; call `prewarmConnections()` earlier to pay that cost before a timing loop.

## Releasing

**Bump the `version` in `package.json` (and `package-lock.json`) in any PR that changes the SDK.** Publishing only fires on a version change — a change merged without a bump silently won't release. One bump per PR is enough.

## License

MIT
