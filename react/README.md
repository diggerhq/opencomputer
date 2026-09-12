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

Run `npm run deploy -- --watch` for the agent project to configure the local
authenticated bridge, then start the React application separately with its own
development command, such as `npm run dev:web`.
