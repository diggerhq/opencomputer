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
