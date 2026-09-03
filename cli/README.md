# @opencomputer/cli

The agent-focused OpenComputer CLI creates and deploys cloud agent projects.

```bash
npx @opencomputer/cli init my-agent
cd my-agent
npm install
npx --package @opencomputer/cli opencomputer login
npx --package @opencomputer/cli opencomputer link --project <id-or-slug>
```

Agent definitions live under `opencomputer/agents/`. The default initializer
creates one hello-world agent and no browser application.

Watch source and deploy changes to Development (Cloud):

```bash
npm run deploy -- --watch
```

`opencomputer link --project <id|slug>` links an existing project;
`opencomputer link --create-project <name>` creates and links one. Later
commands reuse that local binding without prompting. An unlinked command fails
with the exact link command needed to proceed.

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

Secret values are accepted only from standard input with `--value-stdin`.
They are write-only: list output contains names, scope, environment, and
allowed origins, never values or command-line arguments.

During development, `opencomputer doctor` checks names referenced by
`useSecret()` against `opencomputer/.env.example` and the ignored
`opencomputer/.env.local`. Upload values explicitly with `secrets set`; the CLI
infers and enforces origins declared by `defineConnection()`.

```bash
# Project-level development secret. Allowed origins are inferred from code.
printf %s "$GITHUB_TOKEN" | opencomputer secrets set GITHUB_TOKEN --value-stdin

# Agent-level production override.
printf %s "$GITHUB_TOKEN" | opencomputer secrets set GITHUB_TOKEN --value-stdin \
  --agent current \
  --environment production

opencomputer secrets list --environment development
opencomputer secrets remove GITHUB_TOKEN --environment development
```

For values that agent code and commands must read directly from the process
environment, use encrypted agent runtime variables. They require no source
declaration and apply to newly started runtimes:

```bash
printf %s "$DATABASE_URL" | opencomputer env set DATABASE_URL --value-stdin
printf %s "$DATABASE_URL" | opencomputer env set DATABASE_URL --value-stdin --agent current --environment production
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

Use `opencomputer sessions tail <session-id> --json` for durable NDJSON session
events and `opencomputer channels status --json` for the last accepted event,
delivery outcome, and redacted error category. All commands accept `--json`;
mutations accept `--idempotency-key <stable-retry-key>`. Run
`opencomputer doctor --json` for the sub-second local pre-deploy scan.
