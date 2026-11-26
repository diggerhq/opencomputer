# @opencomputer/sdk

The official TypeScript client for the [OpenComputer](https://github.com/diggerhq/opencomputer) **Serverless Agents** management API. It has one entry point, `@opencomputer/sdk/agents`.

> **3.0.0 removed the sandbox client.** `Sandbox`, `Browser`, `SandboxAgent`, `Templates`, `Image`, `Snapshots`, sandbox `Webhooks`, `verifyWebhook`, `SecretStore`, `Usage`/`Tags` and everything else that was exported from the package root (`@opencomputer/sdk`) and `@opencomputer/sdk/node` are gone, because the OpenComputer sandbox platform is shut down. Importing the package root now fails to resolve. Code that still needs the sandbox client pins `@opencomputer/sdk@2`; `@opencomputer/sdk/agents` is unchanged from 2.3.1. Versions before 2.0.0 also carried a client for the retired Durable Agent Sessions API. See the [CHANGELOG](./CHANGELOG.md).

## Install

```bash
npm install @opencomputer/sdk
```

## Usage

Serverless Agents (`opencomputer deploy`) are managed over the [management API](https://opencomputer.dev/agents/api). The client is the `@opencomputer/sdk/agents` subpath export, whose module graph has no Node dependency and runs nothing at import, so the same code serves a Cloudflare Worker without Node compatibility, Vercel, Deno and Node. Use it from trusted server code; the API key must not reach a browser.

```typescript
import { OpenComputer, OpenComputerError } from "@opencomputer/sdk/agents";

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
  idempotencyKey: "topic/workshop/1",
});
// document.created, session.created: false when they already existed.
```

`startSessionOnDocument({ apiKey, ...params })` from the same subpath is the standalone form of the call.

## Configuration

| Option    | Default                                            |
|-----------|----------------------------------------------------|
| `baseUrl` | `https://app.opencomputer.dev/api/managed-agents`  |
| `apiKey`  | required                                           |
| `fetch`   | the global `fetch`                                 |

## Releasing

**Bump the `version` in `package.json` (and `package-lock.json`) in any PR that changes the SDK.** Publishing only fires on a version change — a change merged without a bump silently won't release. One bump per PR is enough.

## License

MIT
