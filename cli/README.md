# @opencomputer/cli

The agent-focused OpenComputer CLI creates, develops, and deploys projects that
contain agent code and a React application.

```bash
npm install --global @opencomputer/cli
opencomputer login
opencomputer init my-agent
cd my-agent
npm install
```

Initialization creates a remote OpenComputer project and a local hello-world
app. Agent definitions live under `opencomputer/agents/`; the generated React
app lives under `src/`.

Use two terminals during development:

```bash
# terminal 1 — local agent server
npm run dev

# terminal 2 — Vite React app
npm run dev:web
```

The React app uses the generated `useAgent` hook. Vite proxies agent requests
to the local server and injects its development credential server-side.

Deploy the same agent source when it is ready:

```bash
opencomputer deploy --alias production
opencomputer run hello-world "Say hello"
```

The CLI calls the public OpenComputer API and uses OpenComputer authentication.
It does not require a separate backend account, key, or CLI.
