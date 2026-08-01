# OpenComputer CLI

The OpenComputer CLI treats every agent as a normal source repository. A
template creates editable instructions, TypeScript tools, connection
declarations, channel code, a sandbox workspace, and committed agent identity.

[Bun](https://bun.sh/) 1.2 or newer is required. The CLI is still installed
and published through npm:

```bash
npm install --global @opencomputer/cli
opencomputer login
opencomputer templates
opencomputer init email-triage
cd email-triage
npm install
opencomputer connect google
opencomputer dev
opencomputer session "Triage today's inbox."
opencomputer deploy
```

Authentication is stored separately from the legacy `oc` CLI in
`~/.opencomputer/config.json`. `OPENCOMPUTER_API_KEY` and
`OPENCOMPUTER_API_URL` can be used in CI.

The generated repository is deliberately flat:

```text
email-triage/
├── opencomputer.toml
├── package.json
├── instructions.md
├── agent.ts
├── tools/
├── connections/
├── channels/
├── skills/
├── workspace/
└── evals/
```

`opencomputer.toml` is committed with the agent and contains its stable ID.
The directory can be renamed without creating a different deployed agent; each
`opencomputer deploy` publishes a new immutable deployment and advances the
selected alias.

## Sessions

`opencomputer dev` starts the local agent service and opens its React browser
app. The app uses the AI SDK message lifecycle and supports multiple independent
sessions, multi-turn conversations, and streamed tool activity:

```bash
opencomputer dev
```

For a terminal-only workflow, `opencomputer session` automatically starts a
temporary local service when one is not already running and opens an OpenTUI
multi-turn interface. The service is stopped when the interface exits:

```bash
opencomputer session
```

Pass a prompt for a single turn. This also starts and stops the service
automatically when needed:

```bash
opencomputer session "Triage today's inbox."
```

Deployed sessions have their own lifecycle and can be resumed across CLI
invocations:

```bash
opencomputer session create --remote \
  --agent gmail-summarizer@production
opencomputer session list
opencomputer session send <session-id> "Summarize today's inbox."
opencomputer session inspect <session-id>
opencomputer session attach <session-id>
opencomputer session end <session-id>
```

Add and manage account connections and agent channels from the same CLI:

```bash
opencomputer connections connect gmail
opencomputer connections list

opencomputer channels add slack
opencomputer deploy
opencomputer channels connect slack --remote
opencomputer channels list
```
