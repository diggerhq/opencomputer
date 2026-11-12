# Calvin

**A coding agent that works live in a Slack thread.**

Mention the bot (in our Slack it's called Computer) with a task, and an agent
starts working on it in the thread, in its own workspace. You watch it think, run commands, edit files and spawn
subagents as it happens, and you can steer it the way you would in a terminal:
type while it works, interrupt it, approve or deny tools, switch modes. When
the work is done it leaves through git: a branch, a push and a pull request.

> **Status:** a working prototype that a small team uses every day. Sessions
> will run on [OpenComputer](https://github.com/diggerhq/opencomputer), and this
> repository will then be a public example of building on it. Until then they
> run on VMs we host, with the Claude Agent SDK as the agent.

```
you      @Computer the flaky test in auth.spec.ts, find out why and fix it
Computer ⏺ Read auth.spec.ts · ⏺ Bash(npm test -- auth) running 12s …
         The token is created before the mocked clock is installed, so…
you      also check the refresh path while you're there        ← steering mid-turn
Computer 👀 …  ✓ Edit src/auth/refresh.ts · ✓ Bash(npm test)
         Fixed both; opened #412.
         opus-5-5 · default · 2m41s · ctx 38.2k · $0.31
```

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [How the terminal maps onto Slack](#how-the-terminal-maps-onto-slack)
- [Quick start (one machine)](#quick-start-one-machine)
- [Running it for a team](#running-it-for-a-team)
- [Configuration](#configuration)
- [Development](#development)
- [Project layout](#project-layout)

## Features

- **Live streaming.** Text streams in as it is written, through Slack's native
  agent streaming APIs. Tool calls appear as timeline cards with running
  timers and output tails.
- **Steering.** Messages you send while it works are picked up at the next
  tool step. `!! <text>` interrupts and starts over with your text; Slack's
  stop button works like Esc.
- **Knows when to stay quiet.** Others can talk in the thread too. Each message
  reaches the agent with who sent it (Slack name and id), the channel's name, and whether it @mentions the bot; when a
  message isn't for it (people talking to each other, a reply that @mentions
  someone else), it replies `<no-reply/>` and nothing is posted.
- **Approvals in Slack.** Permission prompts, `AskUserQuestion` and plan
  approval become buttons. Replying in the thread instead counts as your answer.
- **Subagents panel.** One live row per subagent with status, current
  activity, tokens and elapsed time, plus Stop and Result buttons.
- **Files and screenshots, both ways.** Uploads in the thread reach the model:
  images inline, other files by path. A `send_file` tool lets the agent post
  files back: screenshots, rendered charts, reports; `calvin-send-file` does
  the same from the script that renders them. Hosts come with a headless
  browser (Playwright, Chromium), ffmpeg and fonts.
- **A workspace per thread.** On a host, every thread gets its own `git
  worktree` of each configured repository on a fresh branch, so threads never
  step on each other. Git and `gh` get short-lived GitHub App tokens on their
  own.
- **Linked threads, when everyone could see them.** Paste a link to another
  Slack message or thread and the session gets its content as context, if
  the bot, the poster, the session's owner and everyone reading this thread
  can all see it; otherwise a note says why not ([details](#linked-threads)).
- **Parallel threads.** A `spawn_thread` tool lets a session start another
  thread for the same person, working from a brief.
- **Secrets without pasting them in chat.** `!secret NAME` (or the agent's
  `request_secret` tool) opens a private Slack form; the value becomes `$NAME`
  in the session's commands, for this session, all of a person's sessions, or
  the whole Slack workspace ([details](#secrets)). Values that are not
  secret (an org name, a hostname) are variables: `!var NAME value`.
- **Zero-copy setup.** The Slack app is created, configured and installed from
  code. You paste one configuration token, once.

## How it works

Each Slack thread is one long-lived agent session. Calvin turns the session's
events (text, tool calls, thinking, subagents, prompts) into Slack messages,
streams and buttons, and turns what people do in the thread (replies, clicks,
the stop button) back into input for the session.

Today the agent is the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview):
one long-lived `query()` with streaming input per thread. This will move to the
OpenComputer backend.

It runs in one of two shapes:

**One machine** (`npm start`). A single process holds the Slack endpoint and
runs every session. Slack reaches it through an ngrok tunnel. Good for trying
it out and for development.

**Split deployment** (for a team). Three pieces with a small contract between
them (`src/protocol.ts`):

```
Slack ──HTTPS──▶ gateway ◀──WebSocket (dialed out)── host agent ──▶ runner per thread ──▶ agent session
                 routing, tables,                    workspaces,         renders straight
                 secrets, GitHub                     runner lifecycle,   to Slack
                 App tokens                          token relay
```

| Piece | Job | Code |
|---|---|---|
| **Gateway** | Slack's HTTP endpoint, event de-dup, allowlist, session table, `/setup`, GitHub webhooks and token minting. It holds no per-session runtime state, so it can restart at any time. | `src/gateway/`, `src/setup/`, `src/github/` |
| **Host agent** | Dials out to the gateway (no inbound ports), forks workspaces, starts one runner per active thread outside its own process tree, rediscovers them after a restart, stops idle ones, serves GitHub tokens to git. | `src/host/`, `src/workspaces/` |
| **Runner** | One agent session per process. It renders to Slack directly, so streaming does not go through the gateway. | `src/runner/` |

On OpenComputer, the host agent's job goes away: each session runs in its own
sandbox instead of as a process on a shared host VM.

## How the terminal maps onto Slack

Calvin aims for the feel of a coding agent in a terminal: you see everything as
it happens and can steer at any moment.

| In a terminal | In Slack |
|---|---|
| tokens stream in | `chat.startStream` / `appendStream`; continuous output is batched every 600 ms; after an idle gap, the next update flushes immediately |
| `⏺ Bash(npm test)` lines | `task_update` timeline cards, one per run of consecutive steps ([details](#tool-cards)) |
| pasted screenshot / file | Slack uploads are downloaded with the bot token (`files:read`) into a per-session temp dir; images go to the model inline, other files by path |
| the agent shows you an image or file | the `send_file` tool uploads a file from the workspace or the temp dir into the thread (`files.getUploadURLExternal`, then `files.completeUploadExternal` once the previous message is closed; `files:write`); output continues below it. `bin/calvin-send-file <path> [comment]` posts the same way from a script, through the runner's `$SP_FILES_SOCKET` |
| the agent shows you numbers, a table or a chart | the `post_card` tool posts a native Block Kit card below the current message, built from a [json-render](https://github.com/vercel-labs/json-render) spec: `@json-render/chat` validates it, Chat SDK's Slack adapter converts it. Invalid specs and ones past Slack's limits are refused with the issues; link buttons only, no click handling yet |
| running timer on slow commands | the task's details are updated every 3 s (`running 1m12s`) |
| the prompt is taken up | a message addressed to the agent (not a steer) opens the reply at once on a `Started` card, before the model answers; the card becomes the first thinking or tool card, or ends as `✓ Started` when text comes first |
| `✻ Thinking…` | a task that appears only if thinking takes longer than 1.5 s (300 ms when it would be the first thing shown; at once when it takes over the `Started` card), ending as `Thought for 4s` |
| subagents (`Agent`) | an agents panel ([details](#agents-panel)) |
| todo list | the `TodoWrite` step shows `☑ ◐ ☐` items |
| permission dialog | buttons: Allow / Allow for session / Deny. The prompt message is deleted after the click, like a dialog closing, and the step shows `allowed by <name>`. Replying in the thread instead declines and passes your text to the agent as instructions |
| `AskUserQuestion` | one button per option. A typed reply counts as the "Other" answer when one question is left; otherwise it closes the prompt and goes to the agent as your words |
| plan mode → `ExitPlanMode` | the plan stays posted, with Approve (auto-accept edits) / Approve (keep asking) / Keep planning |
| typing while it works | the message is queued into the running turn and picked up at the next tool boundary. Your message gets 👀 and the output continues in a new message below it, so the thread reads in order |
| Esc | Slack's native stop button (`agent_session_stopped`) or `!stop` |
| Esc + type | `!! <text>` interrupts within about 1 s and starts a new turn with your text |
| status line | a footer on each turn: `opus-5-5 · default · 34s · ctx 21.3k · $0.12` |
| shift-tab modes | `!mode default\|accept\|plan\|auto\|bypass` |
| (no terminal equivalent) | `spawn_thread` starts another thread for the same person ([details](#spawn_thread)) |
| (no terminal equivalent) | a Slack permalink in your message brings the linked thread along ([details](#linked-threads)) |
| (no terminal equivalent) | `read_thread` and `post_thread` read or answer another thread on request ([details](#linked-threads)) |

### Tool cards

The card shows the latest step: it appears when the model starts writing the
call, then turns to done or error with a short output tail. Earlier steps fold
into `3 earlier: ✓ Read · ✓ Bash ×2`. Slack replaces a card's title but appends
to its details and output, so all live state rides in the title; details and
output are sent once, when the run is done. When text follows, the card
collapses to `Ran N steps`, listing every step.

Once a message holds 4 cards (`FOLD_AT`), it folds into one small grey history
block above (`narration → ✓ step`, last 14 lines) and work continues in a fresh
message. A long turn reads as history plus a short live message.

### Agents panel

One message per batch of subagents, updated in place, with one row each:
status, type, what it is doing now (a model-written line, via
`agentProgressSummaries`), tool calls, tokens and elapsed time. **Stop** stops a
running agent (`stopTask`); **Result** opens its final answer in a modal. The
panel is a plain message rather than part of the stream, so background agents
keep updating after the turn ends.

### `spawn_thread`

Starts another thread for the same person: a short top-level message
(`↳ task · Brief: <doc> · from this thread`) and a session on it with the
parent's mode and model (or the tier the tool's optional `model` argument
picks: `smart`, `fast`, `default`; the message then reads `↳ +smart task`),
which reads the brief first. It asks for approval
unless the session is in bypass mode, and the brief must already be on its
repository's default branch. Split deployment only.

### Linked threads

When a person's message contains a Slack permalink
(`https://<workspace>.slack.com/archives/<channel>/p<ts>`), the gateway reads
it with the bot token before delivering the message (`src/links.ts`). It
shares the content only if all of these hold:

- the link is in this workspace, and the bot is in that conversation;
- the poster and the session's owner can both see it: any full member can see
  a public channel; guests, private channels and DMs need membership;
- whoever reads this conversation can see it too: a public source may not
  reach a guest who isn't in it, and a private source only goes to a
  non-public conversation whose members are all in it (a DM with the bot, for
  its owner). A Slack Connect conversation gets nothing from elsewhere.

The thread's first message, the linked reply and its latest 40 replies (16k
characters at most) follow the message in a `<slack_linked_thread id="…">`
block with a random id. The model is told the block is data, not
instructions. Files are listed by name only. When a check fails, the model
gets a one-line reason that names no private channel or person. Up to 3
links per message; a spawned thread's first message is not expanded. Design:
work 049.

Two tools reach threads without a link in the message (split deployment only):
`read_thread` reads one by link, or by channel id and ts, under the same
checks with the session's owner as the one asking; it never prompts.
`post_thread` posts a reply into one for the owner: in the thread, never at
the top level, with `<!channel>`-style mentions neutralized and
`_Posted for @owner from this thread._` appended. It asks for approval unless
the session is in bypass mode, and stops after 20 posts per runner. In
production, the backend answers both and allows public channels only.

### Secrets

Values never go into messages: Slack keeps those in history and sends them to
the bot in event payloads. `!secret NAME` posts a button only you see; it opens
a modal (Slack sends its input only to the app) with the value, a scope and a
"provide as a file" option. When a session needs a key, the agent calls
`request_secret` instead, which posts the same button in the thread and wakes
the session once the value is set.

| Scope | Gets it | Who can set it | Kept |
|---|---|---|---|
| This session | this thread | anyone enabled | 30 days after the session was last active |
| Just me (user) | every session the person owns | that person | until removed |
| Workspace | every session in the Slack workspace | admins | until removed |

The narrowest scope wins on a name clash. `!secret` lists names (never values),
`!secret rm NAME [session|me|workspace]` removes one, `!secret help` explains.
`!secret` is handled by the gateway and never reaches the session.

**Where values live.** The gateway is the copy of record: AES-256-GCM, with
each row's scope, owner and name as associated data, so a row copied elsewhere
does not decrypt. In production that is the backend's per-organization
`ComputerDurableObject` (`src/computer/secrets-store.ts`); the Node gateway uses its SQLite (`user_secrets`, key from
`SP_STORE_KEY`, admins are `"admin": true` in `SP_PEOPLE`). A session's set
rides on every delivery and is pushed whenever it changes.

**On the host** the runner writes them to a per-session directory under
`SP_RUN` (tmpfs on the VM, mode 700, deleted when the runner exits) and sets
`CLAUDE_ENV_FILE`, which Claude Code sources before Bash commands, so a secret
added mid-session is in the next command's environment. A file secret's
variable holds the path of a file with the value. Everything the runner posts
to Slack has known values replaced by `[secret:NAME]`, and `send_file` refuses
files that contain one. That guards against accidents, not against a session
set on leaking a value: until each person has their own Unix user (work 046),
all sessions on a host run as one user and could read each other's
environment. Names that would change how the session runs (`PATH`, `HOME`,
`SP_*`, `CLAUDE*`, `ANTHROPIC_*`, `GIT_*`, `LD_*`, …) are refused. Split
deployment only. Design: work 046, decision 5.

**Variables** are values that are not secret, such as an organization's name or a
hostname. They are typed into a plain message: `!var NAME value
[session|me|workspace]` (default this session; backticks keep a value exact),
`!vars` lists them with their values, and `!var rm NAME [scope]` removes one.
They are stored and delivered like secrets, with the same scopes, rules and
`values.sh`, but flagged `variable: true`: never redacted, and `send_file` does
not refuse files that contain them. Within one scope a name is either a secret
or a variable. A variable does not replace a secret; setting a secret over a
variable is allowed, because that only tightens it.

### Commands and code channels

`!help` `!stop`/`!esc` `!! <text>` `!mode <m>` `!model <tier|id>` `!status` `!diff` `!restart` `!secret` `!var` `!done`.
Start any message with `+smart` or `+fast` (or `+default`) to switch the
thread's model and send the rest, e.g. `@Computer +smart redesign the router`
or `@Computer +fast ch bump the deps`. People pick a tier, not a model: the tiers
map to ids in `src/tiers.ts` (smart → Fable, fast → Sonnet, default → `MODEL`).
A new session's first reply is a small header with the thread's id
(the fork directory and `sp/<id>` branch suffix, in a copyable form) and a
pointer to `!help`; `!status` repeats the id.

A runner keeps the release it started with until it idle-exits. `!restart`
moves just that thread to the newest release: the runner exits once the current
turn ends, and the next message starts a new one that resumes the same
conversation (same SDK session, mode and model).

`@bot ch <task>` opens a Slack code channel instead of a thread. There you post
top-level messages without mentioning the bot. The context bar shows the
working directory, branch, model, mode and cost; the diff tab updates after
each turn that changes files; `!done` archives the channel.

### Fallbacks

- If `chat.startStream` fails (plan or scopes), the renderer posts one markdown
  block and calls `chat.update` on it about once a second.
- If an `appendStream` fails, for example because Slack closed a stream that
  sat idle while waiting on a human, the message is reopened as a new stream
  that carries all the content so far.
- Any agent-session API that fails is logged once with its error code, and the
  bot keeps going.

## Quick start (one machine)

You need Node 24, [ngrok](https://ngrok.com/), a Slack workspace where you can
create apps, and credentials for the agent: either `ANTHROPIC_API_KEY`, or a
local Claude Code login, which the Agent SDK picks up.

```sh
npm install
npm start
```

On the first run this:

1. opens api.slack.com/apps and asks you to paste a configuration **Refresh
   Token** (under "Your App Configuration Tokens", click Generate Token and pick
   the workspace). This is the only thing you paste.
2. rotates the configuration token pair (they last 12 hours) and writes the new
   pair to `.env`.
3. creates the Slack app with `apps.manifest.create` (the manifest is in
   `src/provision.ts`) and saves its credentials to `.env`.
4. starts an ngrok tunnel and points the app's events, interactivity and OAuth
   redirect at it with `apps.manifest.update`.
5. opens `<tunnel>/slack/install` in your browser. Click Allow, and the bot
   token is saved to `.env`.

Later runs rotate the token, update the URLs and start. Then invite the bot to a
channel and post `@computer <task>`, or DM it. (`SLACK_APP_NAME` sets the
name; the default is "Computer".)

> [!WARNING]
> Sessions start in `bypassPermissions` mode, so tools run on your machine
> without asking. Set `PERMISSION_MODE=default` or use `!mode default` in a
> thread to get approval buttons.

Each session works in `./workspaces/<session>`, a scratch git repository,
unless `WORKDIR` points every session at one checkout.

### Why a tunnel

Two steps need Slack to reach your machine over HTTPS:

- **Installing.** Installing is always an OAuth consent, and Slack only accepts
  HTTPS redirect URLs.
- **Receiving events.** The alternative, Socket Mode, needs an app-level `xapp-`
  token, which Slack can only create in its UI, not through an API.

So the bot runs in HTTP mode behind ngrok. Set `NGROK_URL` to pin a reserved
domain, or `PUBLIC_URL` to use a different tunnel.

If Slack rejects the agent features in the manifest (`agent_view`,
`code_channels`, the `agent_session_stopped` event), the bot drops them, logs a
warning and continues without them. Turn them on under **Agents & AI Apps** in
the app settings. Some agent features need a paid Slack plan.

## Running it for a team

In production the gateway is the backend, managed-agents
(`src/computer/`, Worker at `managedagents.opencomputer.dev`), and the host agent and runners
run on Azure VMs provisioned by `deploy/vm/provision.sh` (Ubuntu 24.04; EC2
also works), one per organization, sized to its plan. Runners are `systemd --user` units, and the runner user cannot
reach the cloud metadata server. Hosts take new code as a release bundle
(`deploy/bundle.sh`) and update themselves (`deploy/vm/self-update.sh`).

The Node gateway in `src/gateway/` is the self-hosted alternative and what the
laptop and the e2e checks use; the `Dockerfile` packages it as a container.


### Workspaces

With `SP_DEFINITION` set (for example `definitions/computer.json`), each
person gets `<SP_DATA>/people/<dir>/ws/`: clones of the definition's
repositories plus its root files, kept current by housekeeping. Each session
forks it into `<SP_DATA>/people/<dir>/sessions/<key>/`: a `git worktree` per
repository on branch `sp/<key>` from `origin/<default>`, fetched at fork time.

No session waits on a clone (work 056). A fork gets the clones that exist;
missing ones are cloned in the background. A repository with `"clone":
"lazy"` is cloned only when a session checks it out with the `checkout_repo`
tool, as a partial clone (`--filter=blob:none`), and is kept fetched from
then on. When a fork lacks some of the definition's repositories, its
`AGENTS.md` gains a "Repositories in this workspace" index of all of them,
using the optional `description`, `language` and `pushedAt` fields.

A gateway may send the definition instead, in `welcome.definition` (an
organization's computer, work 052): the host validates it, keeps it in
`<SP_DATA>/definition.json` and from then on uses it in place of
`SP_DEFINITION`, in the host and its runners; a changed one triggers
housekeeping. Without one, `SP_DEFINITION` applies as before.

Git and `gh` get GitHub App tokens from the host's token socket. Configure the
runner user once (path as installed):

```sh
git config --global credential.https://github.com.helper ''
git config --global --add credential.https://github.com.helper /opt/slack-presence/bin/git-credential-slack-presence
git config --global credential.https://github.com.useHttpPath true
```

and put `bin/` first on runners' `PATH` for the `gh` shim (set `SP_REAL_GH` if
the real `gh` is not on `PATH`). Runners need `SP_RUN` and `SP_SESSION_KEY`.

## Configuration

**One machine** (`.env`; see [`.env.example`](.env.example)). Slack
credentials are written there for you.

| Variable | Default | |
|---|---|---|
| `SLACK_APP_NAME` | `Computer` | app and bot name |
| `NGROK_URL` / `PUBLIC_URL` | ngrok picks a domain | reserved ngrok domain / your own tunnel |
| `PORT` | `3170` | |
| `WORKDIR` | `./workspaces/<session>` | one checkout shared by every session |
| `PERMISSION_MODE` | `bypassPermissions` | `default` (ask), `acceptEdits`, `plan`, `auto`, `bypassPermissions` |
| `MODEL` | `claude-opus-5-5` | the `default` tier; per thread: `+smart`/`+fast`, `!model <tier|id>` |
| `STREAMING` | on | `off` forces the `chat.update` renderer |
| `FLUSH_MS` | `600` | minimum interval between timed native stream flushes; the first update after an idle gap flushes immediately |
| `SP_PROMPT_CACHE_TTL` | `1h` on Anthropic's API; Claude Code's default (`5m` on a key) through `anthropicBaseUrl` | Claude Code's prompt cache TTL, main conversation and subagents (`5m` or `1h`; sets `CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`); also passed from a host to its runners. Through an Anthropic-compatible endpoint (an organization's OpenRouter key) OpenRouter documents `cache_control.ttl: "1h"` on its Messages API, but it is untested with Claude Code (which also sends the `extended-cache-ttl-2025-04-11` beta), so it is opt-in there |
| `SP_PROMPT_GUARD` | on | `off` stops withholding copies of Calvin's own prompt from what it posts (`runner/prompt-guard.ts`), for a deployment that works on Calvin itself; also passed from a host to its runners |
| `SP_COMPACT_AT` | `120000` | after a turn whose last request carried more than this many tokens (or after 40 min idle above 60k), the conversation is compacted between turns in a fork that is swapped in only if no message arrived meanwhile (`runner/harness/claude/shadow.ts`, work 068 1c); `0` turns it off. Also passed from a host to its runners |
| `SP_CONTEXT_WINDOW` | `183000` | Claude Code's own auto-compact window in tokens, the backstop for a single turn that grows past the fork compaction (sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; `0` leaves Claude Code's default, the model's window, 1M for Opus here). Claude Code compacts inside the turn, which waits, once a request would carry about the window minus 33k (150k at the default; the window is floored at 100k). Also passed from a host to its runners |

**Host workspaces**

"Passed to runners" means from the host's own environment only: the host
sets every one of them on every launch (`src/runner-env.ts`), empty when it
has none, so a runner never takes a value from the user manager's
environment, which any session can change.

| Variable | Default | |
|---|---|---|
| `SP_DEFINITION` | unset (scratch dirs) | workspace definition JSON; `<SP_DATA>/definition.json` (from the gateway) wins |
| `SP_DATA` / `SP_RUN` | `/data` / `/run/slack-presence` | data volume / token socket dir |
| `SP_FETCH_INTERVAL` | `5m` | housekeeping period (`300`, `30s`, `5m`) |
| `SP_FETCH_TIMEOUT` / `SP_FORK_FETCH_TIMEOUT` | `2m` / `5s` | fetch timeouts; a fork whose fetch times out uses cached refs |
| `SP_FORK_FETCH_FRESH` | `60s` | a fork skips its fetch of a clone fetched this recently and not pushed to since (push webhook); `0` always fetches |
| `SP_FORK_RETENTION_DAYS` | `14` | idle forks with nothing unpushed are removed after this |
| `SP_ARTIFACTS_IDLE_HOURS` | `24` | forks idle this long (no live runner) lose their git-ignored build and dependency directories (`node_modules`, Rust `target`, `.venv`, `.next`, caches; `src/workspaces/idle.ts`); an install or build restores them |
| `SP_POOL_SIZE` | `2` | spare runners a host keeps with Claude Code parked, so a new session's first message skips the runner's launch and Claude Code's start (`host/pool.ts`, work 069). A spare is claimed into the session's fork; resumed sessions, and hosts without a prepared workspace for the owner, start cold. `0` turns the pool off |
| `SP_MODEL_PROXY` | unset (every session on the organization's credentials) | oc-modelproxy's control socket (`/run/oc-modelproxy/control.sock`): sessions may run on their owner's Claude subscription (work 077); set only on a host running as `sp-host` |
| `SP_RUNNER_USER` | unset (runners run as the host's user) | start runners as this user through `sudo -n -u` (work 077, `host/runner-user.ts`), for a host running as `sp-host` |
| `SP_MODEL_SOCKET` | `/run/oc-modelproxy/api/api.sock` | the proxy's socket a subscription session's Claude Code uses (`ANTHROPIC_UNIX_SOCKET`); passed to runners |
| `SP_CODEX_BIN` | `/usr/local/lib/codex/bin/codex` | the pinned Codex CLI a `harness: 'codex'` session runs as `codex app-server` (work 082); passed to runners |
| `SP_CODEX_PEER_CHECK` | on | `off` lets any local process use a Codex session's model loopback; only where runners are not systemd units (a laptop). On, a connection is forwarded only when a process in the runner's own cgroup holds it, and refused if the cgroup cannot be read. Read from the host's own environment only: runners always get `on` unless the host runs with `off` |
| `SP_IMAGE` / `SP_IMAGE_ABI` | unset | the session image of this release (`ghcr.io/diggerhq/computer-session:<git tree of deploy/image>`) and the integer in `deploy/image/ABI` (work 103). Never set by hand: `deploy/vm/provision.sh` writes both to the release's `.sp-version.env`, which the host unit loads, and pulls and warms the image before it switches to the release (`deploy/vm/sandbox.sh`). A host with `SP_LAUNCH=podman` refuses to start without both |
| `SP_LAUNCH` | `systemd` on a hosted computer, `detached` elsewhere | how a runner is started (`host/launch.ts`): `systemd` (a user unit of the runner user), `detached` (a child process, on a laptop), or `podman` (work 103: each session in its own container `sp-runner-<id>` of `SP_IMAGE`, started by `podman start --attach` in a unit of the runner user; `host/sandbox/`). `podman` needs `SP_RUNNER_USER`, `SP_IMAGE`, `SP_IMAGE_ABI` and `SP_POOL_SIZE=0`, and a computer prepared by `deploy/vm/sandbox.sh`; a session's workspace, the person's clones and the thread's own worktree registries are mounted into it by `bin/sandbox-mount.py`, and its worktrees are added inside it by `bin/ws-add.sh`; clones, fetches and the question which build directories git ignores run in helper containers, so the host runs no git on what a session wrote. Until the work is finished it is for trying out only: a restarted host does not take its containers back, and previews, the terminal and `/files` are refused |

**Telemetry** (work 054; runners always hand telemetry to their host, which sends it only if `SP_TELEMETRY_URL` is set)

| Variable | Default | |
|---|---|---|
| `SP_TELEMETRY_URL` | unset (validate and discard) | collector base URL; batches go to `POST <url>/v1/events`, spooled in `<SP_DATA>/state/telemetry/spool` (≤ 100 MB) until accepted |
| `SP_TELEMETRY_CREDENTIAL` | unset (spool, don't send) | this host's signed collector credential; a newer one from the gateway's `welcome` is kept in `<SP_DATA>/state/telemetry/credential` and wins |
| `SP_REGION` | `unknown` | region stamped on every record (e.g. `westus2`); passed to runners |
| `SP_SUBSTRATE` | unset | where runners run (`vm`, `oc-sandbox`); a telemetry dimension, passed to runners |

**Wire relay** (work 084; `dist/wire.js`, `src/wire/main.ts`, run by `slack-presence-wire.service` as `sp-wire`; see [`deploy/vm/RUNBOOK.md`](deploy/vm/RUNBOOK.md))

| Variable | Default | |
|---|---|---|
| `SP_WIRE_LISTEN` | `127.0.0.1:7071` | where the relay listens; the tunnel's `<tunnelId>.w.opencomputer.dev` ingress points here. Loopback only: every request still needs the edge signature |
| `SP_WIRE_SOCKET` | `<SP_RUN>/wire/wire.sock` | the host's wire socket (`host/wire-link.ts`): edge key, access lists, writers, terminals, files |
| `SP_RUN` | `/run/slack-presence` | as the host's; the relay dials session writers at `<SP_RUN>/runners/<id>.api.sock` |
| `SP_VERSION` | `dev` | the release's commit, in `ready.server.version` (the unit reads it from `.sp-version.env`) |
| `SP_REGION` | unset (`null`) | `ready.server.region` |

Gateway variables are documented at the top of `src/gateway/main.ts`.

## Development

`npm run check` is the gate: typecheck (`tsc`), lint (`biome lint`), unit tests
(`vitest run`, the `*.test.ts` files next to the code) and a file-size ratchet
(`scripts/max-lines.mjs`) and an import-boundary check (`scripts/boundaries.mjs`:
`gateway/`, `host/` and `runner/` share code only through top-level `src/`).
CI runs it on every pull request, and `main` deploys only after it passes. `npm run format` applies the formatter.

The integration checks below spawn real processes and are run by hand. None
of them need a real Slack workspace.

| Command | What it checks |
|---|---|
| `npx tsx src/dev/fake-run.ts "<prompt>" ["<steer sent 8s later>"]` | A real agent session against a fake Slack client. Prints every Slack API call with a timestamp and approves prompts automatically. The fast loop for event mapping, batching and steering. |
| `npx tsx src/dev/e2e-check.ts [--keep]` | The whole split deployment on one machine, with fake Slack and GitHub APIs served by the check itself: `/setup`, mention → fork → runner → turn, thread replies, mid-turn messages, a permission button, host and gateway restarts under a live runner, GitHub tokens through the credential helper and `gh` shim, a push webhook. Prints the latency rows it can measure. Scratch space is `/tmp/spe2e`. |
| `npx tsx src/dev/host-check.ts [--claude]` | The host agent against an in-process fake gateway: spawn, forwarding, token relay, restart with rediscovery, idle exit. With a fake telemetry collector (work 054): host events per trace, the `new`/`warm`/`resume` path, spooling through a collector outage and a host restart, gap-free batch numbers, and `turn.abandoned` for a runner killed mid-turn, before and after a host restart. |
| `sudo -u sp-host env SP_RUNNER_USER=agent SP_IMAGE=… SP_IMAGE_ABI=… node --import tsx src/dev/sandbox-check.ts` (on a computer, from its release directory, with no host agent running) | The host with `SP_LAUNCH=podman` against an in-process fake gateway and a fake Slack (work 103): a session's runner is a container in a unit of the runners' slice, its record is written, its cwd is `/workspace`, its report names the host's path, its token socket is linked into its run directory, it exits when idle leaving its container, and the next message resumes the same container with its home intact. With a definition of two public repositories: helper containers clone them, a thread has its workspace, its worktree and its own registry mounted, a sibling thread and another person's thread see none of it, `git worktree prune` in one leaves the other, the mount helper refuses what is not the person's, a session of the API has its journal directory, `checkout` adds a repository, and housekeeping removes a stopped thread's ignored `node_modules`. Needs podman and the network (github.com), so it does not run in CI. |
| `npx tsx src/dev/workspaces-check.ts [--real]` | Clones, forks, housekeeping and git auth against local bare repositories. |
| `npx tsx src/dev/gateway-check.ts`, `setup-check.ts` | Gateway routing and `/setup`. |
| `npx tsx src/dev/links-check.ts` | Linked threads against a fake workspace: public, private, DM, guest and Slack Connect cases, other workspaces, caps, and injected instructions in linked text. |
| `npx tsx src/dev/secrets-check.ts` | Secrets: the encrypted vault and its scopes, the env file as bash sources it (changes, removal, files, quoting), redaction of streamed and posted text, `!secret` → button → modal → stored and pushed to a fake host, `request_secret`, `!var` variables, and a real runner process with fake Slack. |
| `npx tsx src/dev/silent-check.ts` | Silent turns from scripted model streams: a `<no-reply/>` reply posts nothing and is never shown. |
| `npx tsx src/dev/model-check.ts` | `!model` and `+smart`/`+fast` against the real Agent SDK with a local stand-in for the Anthropic API (no credentials): switching while idle, mid-turn, an unknown id (clear error, nothing changes) and across a runner restart, asserting the model each API request actually used. |
| `npx tsx src/dev/names-check.ts` | What the model reads about who is speaking and where, against the real Agent SDK with a stand-in Anthropic API (no credentials): the sender's and mentioned people's Slack names, the channel name, one lookup per person and per session, and ids standing in (within ~0.8 s) when Slack fails or hangs. |
| `npx tsx src/dev/telemetry-check.ts` | Runner telemetry (work 054) against the real Agent SDK with a stand-in Anthropic API (no credentials): the event sequence and turn row of a turn that thinks, runs a tool and answers, then a warm turn; thinking counted as model time, not overhead. |
| `npx tsx src/dev/addressing-check.ts` | A real agent in a multi-person thread: answers messages for it, stays silent on others. |
| `npx tsx src/dev/tunnel-check.ts` | Starts the tunnel and Bolt's receiver, then sends a signed `url_verification` through it. |

The e2e check reaches the fakes through the dev-only `SP_SLACK_API_URL` and
`SP_GITHUB_API_URL`.

## Project layout

```
src/
  protocol.ts       the contract between gateway, host and runner; the only code two processes share at runtime
  ipc.ts            newline-delimited JSON over unix sockets (host ⇄ runner, helpers → host)
  tiers.ts          +smart / +fast model tiers (parsed by the gateway, applied by the runner)
  secret-names.ts   which names a secret may have (gateway and runner)
  variables.ts      `!var` syntax and how values are shown (gateway; ported to the backend)
  slack-text.ts     Slack message markup → plain text for the model
  links.ts          Slack permalinks in a message → linked thread content, if everyone may see it
  build.ts          which commit is running (shown in footers and !status)
  log.ts, env.ts    logging; .env load and write-back
  gateway/          Slack endpoint, routing, SQLite tables, host WebSockets;
                    vault.ts and secrets-ui.ts: secrets storage, !secret and the modal;
                    variables-ui.ts: !var; threads.ts: read_thread and post_thread
  host/             host agent: forks, runner lifecycle, token relay;
                    previews.ts: preview URLs (cloudflared, preview-proxy.ts, preview-probe.ts)
  runner/           one session per process:
    main.ts           the process: socket to the host, credentials, deliveries
    session.ts        one conversation: a long-lived Agent SDK query() mapped to Slack;
                      prompts, steering, interrupts
    system-prompt.ts  what is appended to Claude Code's system prompt; SILENT
    help.ts           the !help text
    segment.ts        one live Slack message (native stream or chat.update fallback), timed batching
    format.ts         terminal-style tool titles and output tails
    agents.ts         the subagents panel
    attachments.ts    Slack uploads → model input
    spawn.ts          the spawn_thread tool
    threads.ts        the read_thread and post_thread tools
    preview.ts        the preview and unpreview tools: public URLs for a session's servers
    send-file.ts      the send_file tool: workspace files → the thread
    post-card.ts      the post_card tool: json-render specs → Block Kit cards
    session-secrets.ts  a session's secrets: env file, redaction, the request_secret tool
  setup/            /setup: Slack app, secrets, host tokens
  github/           GitHub App manifest and token minting
  workspaces/       definitions, clones, worktree forks, housekeeping
  main.ts           the one-machine bot (Bolt, HTTP + OAuth install)
  provision.ts      config-token rotation, app manifest create/update, ngrok
  workspace.ts      scratch workdirs and git diff (one-machine mode)
  dev/              fakes and checks
scripts/            `npm run check` helpers: file-size ratchet, import boundaries
bin/                git credential helper and gh shim for hosts; ws-*.sh, the git sequences of src/workspaces
definitions/        workspace definitions (computer.json + its root AGENTS.md)
deploy/             gateway image entrypoint, VM provisioning, runbook
```
