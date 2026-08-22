# @opencomputer/cli

The agent-focused OpenComputer CLI creates and deploys cloud agent projects.

```bash
npx @opencomputer/cli init my-agent
cd my-agent
npm install
npx --package @opencomputer/cli opencomputer login
npx --package @opencomputer/cli opencomputer link
```

Agent definitions live under `opencomputer/agents/`. The default initializer
creates one hello-world agent and no browser application.

Watch source and deploy changes to Development (Cloud):

```bash
npm run deploy -- --watch
```

`opencomputer link` asks whether to create a project or select an existing
project from the authenticated account. Later commands reuse that local binding.
If you skip this step, the first project-scoped command prompts you to link.
Use `opencomputer deploy --watch --project <id|slug>` for non-interactive
selection or `opencomputer deploy --watch --create-project <name>` to create
one explicitly.

The production cloud API (`https://app.opencomputer.dev`) is the default.
Override it only with `--api-url` or `OPENCOMPUTER_API_URL`.

The command prints the cloud dashboard URL. It does not start a local agent
server or a browser application. A colocated web application can use a
separate command such as `npm run dev:web` and be deployed independently.

Deploy the same agent source when it is ready:

```bash
opencomputer deploy --alias production
opencomputer run hello-world "Say hello"
```

The CLI calls the public OpenComputer API and uses OpenComputer authentication.
It does not require a separate backend account, key, or CLI.

## Agent webhooks

Create an environment-scoped webhook that starts a fresh session for the
selected agent. The bearer token is displayed only when created or rotated:

```bash
opencomputer webhooks create daily-hygiene --agent current --environment production
opencomputer webhooks list --agent current --environment production
opencomputer webhooks disable <webhook-id>
opencomputer webhooks rotate-token <webhook-id>
opencomputer webhooks remove <webhook-id>
```

Invoke the URL with a JSON object containing `text`, `payload`, or both. The
structured payload is available to agent code as `input.payload`.

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

For values that agent code and commands must read directly from the process
environment, use encrypted agent runtime variables. They require no source
declaration and apply to newly started runtimes:

```bash
opencomputer env set DATABASE_URL
opencomputer env set DATABASE_URL --agent current --environment production
opencomputer env list --environment development
opencomputer env remove DATABASE_URL --environment development
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
