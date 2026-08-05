# OpenComputer

**Serverless agents.** Build an agent as code, test it locally, deploy it with one command. No infrastructure to run, no servers to keep alive, no agent loop to babysit.

```bash
npm install --global @opencomputer/cli

opencomputer init email-triage gmail-summarizer   # start from a template
cd gmail-summarizer && npm install

opencomputer connection add gmail --alias personal   # managed OAuth, no keys in the project

opencomputer session "Summarize my unread inbox."    # test locally, same connections as prod

opencomputer deploy --alias production               # publish an immutable version

opencomputer run gmail-summarizer "Summarize my unread inbox and call out anything urgent."
```

[Documentation](https://docs.opencomputer.dev/agents/overview) · [Quickstart](https://docs.opencomputer.dev/agents/quickstart) · [Dashboard](https://app.opencomputer.dev)

## Agents as code

An OpenComputer agent is a source-controlled project: identity, instructions, tools, connections, and runtime configuration in a normal directory you review and commit.

```text
gmail-summarizer/
├── opencomputer.toml    # committed identity: stable ID across deployments
├── instructions.md      # the agent's role, rules, and approval boundaries
├── agent.ts             # model and runtime permissions
├── tools/               # code-native tools
├── connections/         # declarations for managed services (Gmail, ...)
├── skills/              # reusable domain knowledge and workflows
├── workspace/           # durable working files packaged with the agent
└── evals/               # repeatable checks for agent behavior
```

Everything the agent is lives in that directory. Review changes in pull requests, and grow the agent by editing files: sharpen `instructions.md`, add a tool, drop in a skill.

## Develop locally, deploy identically

`opencomputer session` runs one task against your working copy; `opencomputer dev` gives you an interactive session. Both use your project files and the same managed connections the agent will use in production, so what you test is what ships.

```bash
opencomputer session "Summarize up to 10 unread Gmail messages. Do not modify any email."
opencomputer dev
```

## Versioned deployment

A stable agent ID points to immutable deployments. Shipping an update is a commit and a deploy; the `production` alias moves to the new version, and rollback is a pointer move.

```bash
git commit -am "Refine inbox urgency rules"
opencomputer deploy --alias production
```

Once deployed, the platform runs the agent for you and manages lifecycle, persistence, and connected services. A completed turn suspends; the next message resumes it with its session and workspace intact. Drive it from the CLI:

```bash
opencomputer run gmail-summarizer "Summarize my unread inbox."

opencomputer session create --remote --agent gmail-summarizer@production
opencomputer session send <session-id> "Summarize today's inbox."
opencomputer session attach <session-id>
```

## Managed connections

Authorize services like Gmail through the CLI. OAuth credentials stay managed by OpenComputer and are never written into the project. Connect multiple accounts with aliases:

```bash
opencomputer connection add gmail --alias personal
opencomputer connection add gmail --alias work
```

## Channels

Connect a deployed agent to Slack from the dashboard and invoke it from DMs or channel mentions, with per-user identity isolation. No Slack files or credentials in your repo.

## Get started

```bash
npm install --global @opencomputer/cli
opencomputer login
opencomputer templates
```

Then follow the [quickstart](https://docs.opencomputer.dev/agents/quickstart): create, connect, test, and deploy a Gmail summarizer from a template.
