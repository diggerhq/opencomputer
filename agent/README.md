# OpenComputer Agent

Reactive authoring API for agent code deployed by OpenComputer.

```ts
import { useInput, useModel, useTool } from "@opencomputer/agent";

export default function Agent() {
  const input = useInput();
  useModel("anthropic/claude-sonnet-4.6");
  if (input.text?.includes("documentation")) useTool("search-docs");

  return "Help the user directly and clearly.";
}
```

The default export is rendered synchronously before each model call. Hooks
describe that call; they do not perform I/O or run the durable agent loop.

- `useInput()` reads the immutable input admitted for this turn. It is not a
  human-in-the-loop prompt; interactive clarification remains a tool action.
- `useModel()` chooses a model. A string uses OpenRouter and retains its normal
  `provider/model` spelling.
- To select an OpenAI-native model that can use a project Codex subscription,
  use an explicit provider: `useModel({ provider: "openai", model: "gpt-5" })`.
- `useTool()` and `useSubagent()` select declared capabilities.
- `useSessionData()` reads the current durable session-data snapshot.
- `useMcpServer()` conditionally selects a declared MCP server.

Use `defineMcpServer()` for stable MCP declarations. Never put credentials
directly in these declarations: OpenComputer resolves referenced secrets
through its managed gateway.

## Secret-backed HTTP connections

Declare the destination and the exact place a secret may be injected. The
secret reference is compiled into deployment metadata; its value never enters
the agent artifact or runtime:

```ts
import {
  bearer,
  defineConnection,
  defineTool,
  useSecret,
  useTool,
} from "@opencomputer/agent";

const github = defineConnection({
  id: "github-api",
  origin: "https://api.github.com",
  methods: ["GET"],
  pathPrefix: "/repos/",
  redirectOrigins: [
    {
      origin: "https://codeload.github.com",
      pathPrefix: "/opencomputer/",
    },
  ],
  headers: {
    Authorization: bearer(useSecret("GITHUB_TOKEN")),
  },
});

const repository = defineTool({
  name: "github_repository",
  description: "Read a GitHub repository.",
  async run() {
    const response = await github.fetch("/repos/opencomputer/example");
    return await response.json();
  },
});

export default function Agent() {
  useTool(repository);
  return "Use GitHub when the user asks about a repository.";
}
```

`defineConnection().fetch()` sends a relative request through OpenComputer's
managed egress gateway. The gateway checks the deployment, agent, environment,
origin, path, and method before resolving and injecting the secret. Redirects
are denied unless the connection declares a matching `redirectOrigins` entry.
The gateway follows at most one redirect for `GET` or `HEAD` and never forwards
the original request headers or managed secrets to the redirect destination.

Hooks may only be called while the managed runtime is rendering an agent.

## Code-defined tools

Define executable capabilities with OpenComputer's harness-neutral `tool()`
API, then enable them reactively with `useTool()`:

```ts
import { tool } from "@opencomputer/agent";

export const hackerNews = tool<{ limit?: number }>({
  id: "hacker_news",
  description: "Fetch current Hacker News stories.",
  input: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
    },
    additionalProperties: false,
  },
  async execute({ limit = 5 }) {
    return JSON.stringify({ limit });
  },
});
```

```ts
import { useInput, useTool } from "@opencomputer/agent";
import { hackerNews } from "./tools/hacker-news.js";

export default function Agent() {
  const input = useInput();
  if (/hacker news|\bhn\b/i.test(input.text ?? "")) useTool(hackerNews);
  return "Use live Hacker News data when that tool is enabled.";
}
```

Tool input uses JSON Schema. Tool code never imports OpenCode; OpenComputer
registers definitions with the active managed harness. Customer-defined tools
are excluded from codemode unless OpenComputer explicitly vets them.
