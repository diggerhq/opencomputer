# opc

**Your organization's Computer, in your terminal.**

`opc` is a command-line client for [Computer](https://app.opencomputer.dev/computer), the agent your team works with in Slack. Sessions are shared: one started here shows up on the dashboard, and a Slack thread can be attached from here.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/diggerhq/opc/main/ci/install.sh | sh
```

This works on macOS and Linux, and on Windows under WSL 2. The script verifies the checksum, installs to `~/.local/bin` and never asks for `sudo`. To update, run it again. [Install](docs/install.mdx) has the options.

The macOS builds are not signed yet. If macOS blocks the first run, use `xattr -d com.apple.quarantine ~/.local/bin/opc`.

`opc` is a prerelease, so commands and output may change before 0.1.0.

## Usage

```bash
opc                       # log in, then start a session
opc "fix the flaky test"  # start one with a message
opc ls                    # list sessions
opc a -                   # attach to the last one
opc a <slack link>        # attach to a Slack thread
opc push ./data           # send a directory; opc pull fetches files
opc diff <id>             # what the agent changed
opc shell                 # a shell in the session's workspace
```

The first run logs you in through your browser. If you already use the `opencomputer` CLI, you are logged in.

In a session:
- `y` or `n` answers an approval, and `a` allows that kind of call for the rest of the session.
- `Ctrl+O` shows what the agent did in full.
- `Ctrl+D` detaches, and the session keeps running.

See the [Quickstart](docs/quickstart.mdx) and [Keys](docs/terminal/keys.mdx).

## Scripts and CI

```bash
opc -p "summarize this week's merged PRs"
opc -p --json "is main green?" | jq -r .result
```

Without a terminal, `opc` never prompts. The exit codes are `0` done, `1` failed, `5` waiting for a person and `124` timed out; [Exit codes](docs/reference/exit-codes.mdx) lists them all. See also [Scripting](docs/cli/scripting.mdx), [CI](docs/cli/ci.mdx) and [For agents](docs/cli/agents.mdx).

## Docs

`opc help <topic>` works offline. Everything else is in [`docs/`](docs/):

- [Concepts](docs/concepts.mdx)
- [Commands](docs/reference/commands.mdx)
- [Troubleshooting](docs/troubleshooting.mdx)
- [Session API](docs/api/overview.mdx), for building your own client

## Privacy

`opc` reports timings and error types. It never sends your messages, the agent's output or file paths, and [Telemetry](docs/reference/telemetry.mdx) lists every field it does send. To turn it off, run `opc config telemetry off`.

## Build from source

```bash
cargo build --release --locked    # Rust 1.89+; the binary is target/release/opc
cargo test --locked               # no account needed
```

[AGENTS.md](AGENTS.md) describes the layout and the checks.

## License

[Apache-2.0](LICENSE)
