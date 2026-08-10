# @opencomputer/cli

The agent-focused OpenComputer CLI creates, develops, and deploys projects that
contain agent code and a React application.

```bash
npm create @opencomputer/start@latest my-agent
cd my-agent
npm install
npx opencomputer login
```

The npm initializer delegates to `opencomputer init` and creates the same
hello-world app. Agent definitions live
under `opencomputer/agents/`; the generated React app lives under `src/`.

Use two terminals during development:

```bash
# terminal 1 — sync agents to Development (Cloud)
npm run dev

# terminal 2 — Vite React app
npm run dev:web
```

The first `npm run dev` asks whether to create a project or select an existing
project from the authenticated account. Later runs reuse that local binding.
Use `opencomputer dev --project <id|slug>` for non-interactive selection or
`opencomputer dev --create-project <name>` to create one explicitly.

The production cloud API (`https://app.opencomputer.dev`) is the default.
Override it only with `--api-url` or `OPENCOMPUTER_API_URL`.

The React app uses the generated `useAgent` hook. Vite proxies agent requests
through the CLI's authenticated bridge; agent execution remains in the cloud.

Deploy the same agent source when it is ready:

```bash
opencomputer deploy --alias production
opencomputer run hello-world "Say hello"
```

The CLI calls the public OpenComputer API and uses OpenComputer authentication.
It does not require a separate backend account, key, or CLI.

## Secrets and managed egress

Secret values are read from a hidden prompt, or from standard input in CI.
They are write-only: list output contains names, scope, environment, and
allowed origins, never values.

```bash
# Project-level development secret. Allowed origins are inferred from code.
opencomputer secrets set GITHUB_TOKEN

# Agent-level production override.
opencomputer secrets set GITHUB_TOKEN \
  --agent current \
  --environment production

opencomputer secrets list --environment development
opencomputer secrets remove GITHUB_TOKEN --environment development
```

Agent code declares secret-backed destinations with `defineConnection()`,
`useSecret()`, and `useConnection()`. Requests use the managed gateway, which
injects a secret only for the declared origin, path, method, agent, and
environment. The plaintext secret is not added to the deployment or runtime.

## Logs

Read runtime stdout/stderr and managed-egress events from the public
OpenComputer API:

```bash
opencomputer logs
opencomputer logs --agent my-agent --environment development --follow
opencomputer logs --session <session-id> --json
```
