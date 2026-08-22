# OpenComputer

Build, steer, and deploy serverless agents as code. An OpenComputer project
contains one or more agents that run in the cloud.

```bash
npx @opencomputer/cli init my-agent
cd my-agent
npm install
npx --package @opencomputer/cli opencomputer login
```

Watch agent code and deploy changes to Development (Cloud):

```bash
npm run deploy -- --watch
```

[Documentation](https://docs.opencomputer.dev/agents/overview) · [Quickstart](https://docs.opencomputer.dev/agents/quickstart) · [Dashboard](https://app.opencomputer.dev)

## Project structure

`npx @opencomputer/cli init <directory|.>` creates a hello-world agent project:

```text
my-agent/
├── opencomputer/
│   ├── project.ts
│   └── agents/
│       └── hello-world/
│           └── agent.ts
└── package.json
```

The `opencomputer/` tree contains the cloud agent definitions and is designed
to grow to multiple agents in one project. A browser application can live in
the same repository, but it has its own development and deployment lifecycle.

## Develop and deploy

On the first `npm run deploy -- --watch`, choose an existing project from your account or
create a new one. That binding is reused on later runs. The CLI uses
`https://app.opencomputer.dev` by default; pass `--api-url` or set
`OPENCOMPUTER_API_URL` only when intentionally targeting another service.

Edit the agent function, tools, connections, and routing while watched cloud
deployment is running. Test it from the dashboard or CLI.

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
opencomputer init my-agent
opencomputer agents
opencomputer session "Say hello"
opencomputer deploy --watch
opencomputer deploy --alias production
opencomputer run hello-world "Say hello"
```
