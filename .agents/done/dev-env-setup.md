# Dev env — prod-mirror dashboard edge

**Done.** Shipped on `feat/web-ui-dev` (PR #426).

## What

Stood up a personal **api-edge Worker** that mirrors prod's serving topology in
front of Igor's GCP dev box, so the dashboard frontend runs the *real* edge path
(SPA served from the Worker + WorkOS auth at the edge + `/api/dashboard` from D1)
instead of the local Vite dev server. Useful for validating edge-specific
behavior — e.g. the WorkOS hosted-logout flow, which the vite-local setup bypasses.

## Resources

- Worker `opencomputer-api-edge-igor-dev` in **Mo's CF account** (`b8f23cb8`),
  URL `https://opencomputer-api-edge-igor-dev.mo-b8f.workers.dev`.
- D1 `opencomputer-igor-dev` (schema = `cloudflare-workers/schema.sql`).
- Backend: GCP dev box `34.181.232.88` (`deploy/gcp/deploy-qemu-dev.sh`).
- Config: `cloudflare-workers/api-edge/wrangler.igor-dev.toml` (extended with
  `[assets]` to serve the SPA).

## Quirks discovered (the reason this is documented)

- `~/.opensandbox-gcp-dev.env` uses `${VAR:-default}` references — must be
  **sourced**, not `grep|cut`'d, or WorkOS rejects the literal `${...}` as
  `invalid_client`.
- `cloudflare-workers/api-edge/wrangler.toml` points at **prod** — always pass
  `--config wrangler.igor-dev.toml` for personal-dev `wrangler` commands.
- D1: apply only `schema.sql`; the `schema_phase*.sql` files are baked in and
  error with `duplicate column` on a fresh DB.

## Where it lives (living references — keep these current, not this record)

- **Runbook:** `.agents/work/dev-edge-setup.md` (full setup/redeploy/box-as-cell).
- **Discoverability:** `AGENTS.md` → "Local development" section.

## Status / follow-up

Login, dashboard shell, and edge logout work. **Box not yet wired as a cell**, so
session/checkpoint lists are empty until it reports into the edge's D1 (steps in
the runbook: shared `SESSION_JWT_SECRET` + a `cells` row). Commits: `02603ef`
(setup + runbook), `d12b647` (env-sourcing gotcha), `24e0a7d` (AGENTS.md pointer).
