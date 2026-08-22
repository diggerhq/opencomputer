# @opencomputer/react

React hooks for applications that interact with OpenComputer agents.

```tsx
import { useAgent } from "@opencomputer/react";

const agent = useAgent("support@development");
```

Run `npm run deploy -- --watch` for the agent project to configure the local
authenticated bridge, then start the React application separately with its own
development command, such as `npm run dev:web`.
