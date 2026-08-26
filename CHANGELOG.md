# Changelog

## Aug 25–26 2026

### Features

- **Bring Your Own Key (BYOK) — Codex subscription (Pro/Max):** Pro and Max organizations can now connect their own OpenAI/Codex subscription to OpenComputer, enabling agent runs to dispatch over their own Codex account. The connection is established through a local CLI OAuth flow (`opencomputer model-access connect codex`), is scoped per project (Development and Production environments), and can be enabled or disabled by project admins without repeating OAuth. The dashboard Settings panel reflects connection and binding status. BYOK is gated to Pro and Max plans; base-plan organizations see an upgrade prompt. ([#680](https://github.com/diggerhq/opencomputer/pull/680), [#682](https://github.com/diggerhq/opencomputer/pull/682), [#683](https://github.com/diggerhq/opencomputer/pull/683))
- **Dashboard: live streaming of active session responses:** The managed-session Conversation tab now reconstructs and displays the assistant's response in real time from streamed events while a turn is active, with an explicit streaming indicator. Previously, the tab showed only "Turn running." until the turn completed. ([#692](https://github.com/diggerhq/opencomputer/pull/692))

### Bug fixes

- **Dashboard: full session history for long sessions:** The session detail page now paginates durable event history so sessions with more than 500 events display their complete conversation and assistant responses. Subsequent refreshes fetch only new events. ([#693](https://github.com/diggerhq/opencomputer/pull/693))
- **CLI: agent turns no longer time out prematurely:** The CLI deadline is refreshed whenever new session events arrive, so long multi-step agent turns remain attached until they complete. The timeout still fires for genuinely silent or stuck sessions. Ctrl-C detaches locally while the remote session stays durable. ([#691](https://github.com/diggerhq/opencomputer/pull/691))
- **CLI/packaging: agents with imported sibling modules now deploy correctly:** The agent compiler now follows and packages all local relative imports reachable from the agent and tool entry modules. Previously, an agent that imported a sibling such as `config.ts` would compile locally but fail at runtime with a missing-module error after deployment. Unresolved imports now fail packaging explicitly. ([#687](https://github.com/diggerhq/opencomputer/pull/687))
- **Dashboard: durable session navigation toggle removed from user Settings:** The legacy durable sessions checkbox has been removed from user Settings. Session visibility is now controlled centrally by administrators. ([#684](https://github.com/diggerhq/opencomputer/pull/684))

### CLI releases

- **CLI 0.6.2, 0.6.3, 0.6.4, 0.6.5** released, incorporating BYOK support, project-aware Codex connection, CLI deadline-refresh fix, and agent packaging fixes. ([#681](https://github.com/diggerhq/opencomputer/pull/681), [#682](https://github.com/diggerhq/opencomputer/pull/682), [#691](https://github.com/diggerhq/opencomputer/pull/691), [#687](https://github.com/diggerhq/opencomputer/pull/687))

### Documentation

- **New example: GitHub Actions triage agent:** End-to-end walkthrough for building an agent that triages GitHub Actions failures. ([#685](https://github.com/diggerhq/opencomputer/pull/685))
- **New example: test coverage agent:** Documents the risk-based selection workflow, exact-snapshot approach, safe dry run, and `bash` tool trust boundary. ([#686](https://github.com/diggerhq/opencomputer/pull/686))
- **New example: PR review agent:** Walkthrough for a dry-run-by-default PR reviewer that posts `COMMENT` reviews with inline comments via a managed GitHub connection and webhook ingress. ([#688](https://github.com/diggerhq/opencomputer/pull/688))
- **Runtime filesystem tools:** Clarifies that `bash` and `read` must be registered in `opencode.json` and exposed by the agent's reactive render function; documents errors produced by stale deployments and the scope of filesystem restrictions. ([#689](https://github.com/diggerhq/opencomputer/pull/689))

<!-- opencomputer-changelog:d54f2c239a293216ff13f069ffc1ed7b853f9761 -->
