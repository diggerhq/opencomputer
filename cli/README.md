# @opencomputer/cli

The agent-focused OpenComputer CLI creates, develops, and deploys agent
projects with an optional React application.

```bash
npm create @opencomputer/start@latest my-agent
cd my-agent
npm install
npx --package @opencomputer/cli opencomputer login
npx --package @opencomputer/cli opencomputer link
```

The npm initializer asks whether to include a React SPA, then delegates to
`opencomputer init`. Agent definitions live under `opencomputer/agents/`; the
optional React app lives under `src/`.

Start cloud sync and the optional React app together:

```bash
npm run dev
```

`opencomputer link` asks whether to create a project or select an existing
project from the authenticated account. Later commands reuse that local binding.
If you skip this step, the first project-scoped command prompts you to link.
Use `opencomputer dev --project <id|slug>` for non-interactive selection or
`opencomputer dev --create-project <name>` to create one explicitly.

The production cloud API (`https://app.opencomputer.dev`) is the default.
Override it only with `--api-url` or `OPENCOMPUTER_API_URL`.

The command prints the cloud dashboard URL. A React app imports `useAgent`
from `@opencomputer/react`; Vite proxies requests through the CLI's
authenticated bridge, while agent execution remains in the cloud.

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

During development, put agent secrets in `opencomputer/.env.local`. The CLI
syncs only names referenced by `useSecret()` and limits each value to origins
declared by `defineConnection()`. It asks before the first upload, watches for
changes, and skips unrelated variables rather than granting wildcard access.

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

Agent code declares secret-backed destinations with `defineConnection()` and
`useSecret()`. Requests use the managed gateway, which
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
