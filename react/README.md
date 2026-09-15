# @opencomputer/react

React hooks for applications that interact with OpenComputer agents.

Create a session from the browser during development:

```tsx
import { useAgent } from "@opencomputer/react";

const agent = useAgent("support@development");
```

Attach to a session your server created, for example one bound to
[memory](https://opencomputer.dev/agents/memory):

```tsx
const chat = useAgent({ sessionId, basePath: "/api/agent" });
```

The hook replays the session's history, streams new turns, and reports
`memory.saved` events. It only needs the session's events, turns and
interrupt routes, which your server proxies under its own authentication; the
API key never reaches the browser. See the
[React integration guide](https://opencomputer.dev/agents/react).

`send(text, { idempotencyKey, payload })` takes a key the caller keeps for
that submission's retries and a structured payload the agent reads beside
the text. `turns` lists the session's turns with their status, messages,
tool calls, result and failure, reduced from the same log as `messages`:

```tsx
const { turns, send } = useAgent({ sessionId, basePath: "/api/agent" });
await send("Fix the login page", { idempotencyKey: submissionId, payload: { repo: "acme/web" } });
turns.at(-1)?.toolCalls.map((call) => `${call.title}: ${call.status}`);
```

Run `npm run deploy -- --watch` for the agent project to configure the local
authenticated bridge, then start the React application separately with its own
development command, such as `npm run dev:web`.
