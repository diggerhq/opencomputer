# OpenComputer

Build, steer, and deploy serverless agents as code. An OpenComputer project
contains one or more agents plus the React app used to interact with them.

```bash
npm install --global @opencomputer/cli
opencomputer login
opencomputer init my-agent
cd my-agent
npm install
```

Start the agent server in one terminal:

```bash
npm run dev
```

Start the React app in another:

```bash
npm run dev:web
```

[Documentation](https://docs.opencomputer.dev/agents/overview) · [Quickstart](https://docs.opencomputer.dev/agents/quickstart) · [Dashboard](https://app.opencomputer.dev)

## Project structure

`opencomputer init <directory|.>` creates a complete hello-world project:

```text
my-agent/
├── opencomputer/
│   ├── project.ts
│   └── agents/
│       └── hello-world/
│           ├── opencomputer.toml
│           ├── opencomputer.config.ts
│           ├── agent.ts
│           ├── instructions.md
│           ├── tools/
│           ├── connections/
│           ├── channels/
│           ├── skills/
│           ├── workspace/
│           └── evals/
└── src/
    ├── App.tsx
    └── use-agent.ts
```

The `opencomputer/` tree is the backend definition. It is designed to grow to
multiple agents in one project. The `src/` tree is a normal Vite + React app;
its generated `useAgent` hook talks to the local agent server without exposing
the server token to browser code.

## Develop and deploy

Edit the agent instructions, tools, connections, and routing while the local
server is running. The React app streams turns and keeps the durable session ID
for follow-up messages.

When the project is ready, publish an immutable deployment:

```bash
npm run deploy -- --alias production
```

Deployments are versioned. The dashboard project view exposes Agent playground,
Sessions, Files, Connections, Channels, Schedules, and Agent schema while
keeping infrastructure details behind the OpenComputer API.

## CLI

The TypeScript `opencomputer` CLI is focused on managed agents and is separate
from the legacy Go `oc` CLI. Common commands are:

```bash
opencomputer whoami
opencomputer agents
opencomputer session "Say hello"
opencomputer deploy --alias production
opencomputer run hello-world "Say hello"
```
