# opc

This directory of diggerhq/opencomputer (moved here from diggerhq/opc, history included) is a Rust 2024 CLI (`opc`, one static binary) for an organization's OpenComputer Computer, plus the docs of `opc` and of the session API it uses (HTTP and the `opc.v1` WebSocket). README.md is the user-facing overview. The docs are the spec: `src/cli.rs` implements `docs/reference/commands.mdx`, `src/api/types.rs` follows `docs/api/reference/objects.mdx`.

## Layout

- `src/main.rs`: parse, run one command on a 2-thread tokio runtime, map errors to exit codes, drain telemetry, print `--timing`.
- `src/cli.rs`: the clap command line and `--help` text. `src/error.rs`: every exit code and the error JSON, in one place.
- `src/cmd/`: one file per command or family (`run.rs` is `opc` / `opc -p`, `attach.rs`, `send.rs`, `wait.rs`, `watch.rs`, `push.rs`/`pull.rs`/`transfer.rs`, `shell.rs`, `help.rs` for `help`/`schema`/`completion`, ...). `Ctx` in `cmd/mod.rs` is what every command gets.
- `src/ui/`: the interactive screen. `model.rs` (pure state, no IO), `text.rs` (streaming markdown), `prompt.rs`/`ask.rs`/`list.rs` (pure widgets), `view.rs` (live area), `draw.rs` (inline renderer), `app.rs` (the async loop).
- `src/wire/`: the two sockets. `client.rs` is one connection, `live.rs` the live socket (`Live`) and the actor that owns each watched session's cursor, `reconnect.rs` the `opc.v1` wire actor that owns requests. Commands that wait or watch (`-p`, `send --wait`, `wait`, `watch`, `doctor`'s connection check) use only `Live` and HTTP; the wire is dialled only by what needs the computer (`shell`, and the screen for its connection state and telemetry).
- `src/http.rs`, `src/net.rs`: HTTP/2 client, dialing, TLS, proxy. `src/config.rs`: credentials and URLs. `src/cache.rs`: `~/.opencomputer/opc/`. `src/ids.rs`, `src/render.rs` (plain-line output for `watch`/`log`/`-p`), `src/timing.rs`, `src/telemetry.rs`, `src/log.rs`.
- `src/api/`: hand-written serde types and the Result object.
- `tests/`: integration tests against an in-process fake Computer (`tests/support/`: HTTP API, device login and `opc.v1` WebSocket on one port, a scripted agent picked by the first word of a turn's input). `cli.rs` (commands, exit codes, JSON), `tui.rs` (the screen in a pty), `parallel.rs`, `fake_selftest.rs`. Unit tests live in `#[cfg(test)]` modules next to the code.
- `schema/computer-api.v1.json`: vendored JSON Schema of the API. The fake validates every object it emits against it; `opc schema` prints it.
- `docs/`: the Mintlify site (`docs.json` is the nav). `ci/`: `install.sh` (shipped with each release), `install-test.sh`, `schema-check.sh`.
- The workflows are at the repository root: `.github/workflows/opc.yml` (CI) and `opc-release.yml`.

## Checks

What CI (`.github/workflows/opc.yml`, from this directory) runs on every PR and push to `main` that touches `opc/` or the server's schema, on Linux; macOS runs `cargo test --locked` only:

```bash
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
ci/install-test.sh                       # the install script against a local stand-in for GitHub
ci/schema-check.sh                       # schema/ == ../computer/schema/
```
 Rust 1.89 minimum (`rust-version`). No `rustfmt` check in CI.

## Invariants

- **Exit codes** are a public contract, defined only in `src/error.rs` (`0 1 2 3 4 5 6 124 130`) and documented in `docs/reference/exit-codes.mdx` and the `--help` footer. A turn's outcome is a Result on stdout, never an `Error`. With any JSON format, a command failure is one `{"error": {code, message, retryable, ...}}` object on stderr.
- **Renderer:** no alternate screen, ever. Settled lines are appended once to normal scrollback; only the live area below is redrawn, inside synchronized output (DEC 2026) with the cursor hidden. An idle session writes nothing. Details go through `$PAGER`. Non-tty output is plain lines (`render.rs`); nothing prompts without a tty.
- **Watching (`src/wire/live.rs`):** sessions are watched over the live socket (`GET /live`, `oc.live.v1`) and `GET /sessions/{id}/events`, never over `opc.v1`. A cursor is an opaque string from the server: stored, sent back and compared for equality, never parsed. Every recorded event reaches the consumer once, in `seq` order per session, across reconnects; a pushed range whose `from` is not the cursor held is answered by an HTTP read from the cursor. Only a `reset` (HTTP 409 or frame) discards what was read: events above its `seq` go, here and in the cache, and reading goes on from its `cursor` (from the start when null). A delta's `offset` counts UTF-16 code units; a mismatch sends `block`, and a `whole` delta replaces the block. One task owns all of a socket's state (no locks).
- **Wire (`opc.v1`, JSON-RPC 2.0):** requests, terminals and telemetry. Protocol changes need the server side and the docs (`docs/api/websocket/`) in step.
- **Schema:** do not hand-edit `schema/computer-api.v1.json`; it is a copy of `../computer/schema/computer-api.v1.json` (generated by the server) and `ci/schema-check.sh` fails on any difference. A server change to the schema fails opc's CI until the copy, and the fake in `tests/support/`, follow it.
- **HTTP:** every write carries an `Idempotency-Key`; `429`/`503` are retried after `retryAfterMs` within `--timeout` (60 s without one).
- **Telemetry:** never content (messages, output, paths, commands, keys); ids, numbers and closed-list words only. One raw event per occurrence, no in-memory rollups; aggregation happens downstream. Sent only on an already open WebSocket, never its own connection or HTTP. Off with `OPC_TELEMETRY=0`, `DO_NOT_TRACK=1` or `opc config telemetry off`. The server accepts only a closed table of event names and fields, so a new event or field needs the server change and `docs/reference/telemetry.mdx` updated together.
- **Secrets:** keys and tickets are never logged or printed; config and cache files are `0600`. `OPENCOMPUTER_API_KEY` beats the config file, and the file's key is only sent to the `apiUrl` it was saved for.
- **Startup speed** is gated (`prompt_does_not_wait_for_the_network` in `tests/tui.rs`): keep work off the path from launch to the prompt line.

## Docs

- Voice: plain, second person, present tense, short sentences, no hype, no emoji. Describe what the binary does today.
- `opc help <topic>` embeds docs pages with `include_str!` (`src/cmd/help.rs`): editing `docs/cli/*.mdx`, `docs/terminal/{keys,slash-commands,status-line}.mdx`, several `docs/reference/*.mdx` or `docs/troubleshooting.mdx` changes the binary.
- New pages go in `docs/docs.json`. User-visible changes go in `docs/changelog.mdx`.
- Preview: `cd docs && npx mint dev`. Mintlify generates `/llms.txt` and `/llms-full.txt` for the published site.

## Releases

Push a tag `opc-v*` (for example `opc-v0.1.0-rc.11`) on `main`; the prefix keeps opc apart from the repository's other `v*` releases. `opc-release.yml` builds static musl Linux (x86-64, arm64) and macOS (arm64, x86-64) binaries, signs and notarizes the macOS ones only when the Apple secrets are configured, and publishes `opc-<version>-<target>.tar.gz` (`opc-v0.1.0-rc.11-…`: binary, README.md and LICENSE), `install.sh` and `SHA256SUMS` as a GitHub release, never marked Latest; a version with a `-` is a prerelease. `install.sh` picks the highest `opc-v*` release itself. Releases before `v0.1.0-rc.11` are in diggerhq/opc. `Cargo.toml` stays at `0.1.0` across release candidates, so `opc --version` prints `0.1.0`.

## Server side

The server is `../computer/` (the Computer API, generator of the schema) and `../cloudflare-workers/api-edge/` (the public edge, which sets `x-opc-latest`). Two things here follow it:

- `schema/computer-api.v1.json` is a copy of the server's; `ci/schema-check.sh` compares them.
- The server accepts telemetry only from a closed table of event names and fields (see Invariants), and the `opc.v1` protocol must match `docs/api/websocket/`. A change on both sides can now land in one PR.
