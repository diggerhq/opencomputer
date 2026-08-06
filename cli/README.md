# OpenComputer CLI

The OpenComputer CLI treats every agent as a normal source repository. A
template creates editable instructions, TypeScript tools, connection
declarations, a sandbox workspace, and committed agent identity.

Node.js 22 or newer is required. Install the CLI through npm:

```bash
npm install --global @opencomputer/cli
opencomputer login
opencomputer templates
opencomputer init email-triage
cd email-triage
npm install
opencomputer connection add gmail --alias personal
opencomputer dev
opencomputer session "Triage today's inbox."
opencomputer deploy
```

Initialize and test the PTO Calendar template the same way:

```bash
opencomputer init pto-calendar
cd pto-calendar
npm install
opencomputer connection add calendar --alias work-calendar
opencomputer session
```

The agent checks Calendar events and free/busy information before proposing an
all-day PTO event. Creating the event requires explicit confirmation.

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

## Plugins and operations

Provider integrations can be installed as ordinary npm plugins. A plugin owns
one integration namespace and contributes one or more narrowly scoped,
schema-validated operations plus optional skills.

```bash
npm install @opencomputer/plugin-github
opencomputer plugin check
opencomputer operation list
opencomputer operation describe github.repository.inspect
```

Register the exact operations used by the agent in
`opencomputer.plugins.ts`:

```ts
import { definePlugins } from "@opencomputer/cli/plugin";
import { githubPlugin } from "@opencomputer/plugin-github";

export default definePlugins([
  githubPlugin({
    operations: ["repository.inspect", "repository.checkout"],
  }),
]);
```

Organization plugins use the same npm contract. They may be published or kept
inside the agent repository and installed with a `file:` dependency. The CLI
derives schemas, documentation, package versions, and immutable digests; agent
authors do not maintain a second JSON or YAML operation manifest.

Local operation tests execute the TypeScript implementation and validate both
input and output:

```bash
opencomputer operation test github.repository.inspect --input request.json
opencomputer operation test github.repository.inspect \
  --input request.json --mock test/fixtures/github.json
```

Deployment exposes only registered operations. Credentials remain in managed
connections and are selected using the authenticated session principal; they
are never fields in an operation schema.

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
temporary local service when one is not already running and opens a simple
multi-turn `User:` / `Agent:` prompt. Type `/exit`, `/quit`, or press Ctrl+C to
leave. The service is stopped when the prompt exits:

```bash
opencomputer session
```

Add `--verbose` to retain reasoning, tool, and lifecycle events in the terminal:

```bash
opencomputer session --verbose
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
opencomputer connection add gmail --alias personal
opencomputer connection add gmail --alias work
opencomputer connection add calendar --alias work-calendar
opencomputer connection list
opencomputer connection remove work

opencomputer channels add slack
opencomputer deploy
opencomputer channels connect slack --remote
opencomputer channels list
```
