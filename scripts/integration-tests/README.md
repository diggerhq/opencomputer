# Integration tests

Each test is self-contained, creates its own resources, cleans up in finally,
and exits non-zero on regression. 01-04 are TypeScript SDK tests for the
fork/hibernate/wake fixes in PR #128. 05-08 are Python tests for the
WS-via-DO + migration-survival work in PR #350 — they hit the edge directly
with httpx + websockets so they exercise the actual `/api/sandboxes/...`
edge routes (the SDK takes a different path for PTY/exec WS).

| # | Test file                                  | Validates                                                                                                                    | PR     |
| - | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1 | `01-fork-sync-hibernate.ts`                | `createFromCheckpoint` blocks until worker has the VM registered (no "sandbox not found")                                    | #128   |
| 2 | `02-fork-no-corruption.ts`                 | Forks from savevm-based checkpoints have correct workspace state (no EBADMSG / git segv)                                     | #128   |
| 3 | `03-hibernate-wake-routing.ts`             | Data-plane requests route to the current worker after wake (no "auto-wake failed")                                           | #128   |
| 4 | `04-hibernate-wake-data-preserved.ts`      | Wake does not shadow `/home/sandbox` with an empty mount; all files are readable post-wake                                   | #128   |
| 5 | `05-ws-multi-client.py`                    | Two concurrent PTYs on the same sandbox don't clobber each other (DO Session-set refactor)                                   | #350   |
| 6 | `06-ws-exec-exit-clean.py`                 | An exec that exits cleanly closes the WS with `1000 'exec completed'` exactly once — no post-completion redial loop          | #350   |
| 7 | `07-ws-pty-survives-migration.py`          | Live worker migration with a PTY WS held open: client never closes, file written pre-mig is readable post-mig (lazy rebind)  | #350   |
| 8 | `08-ws-exec-survives-migration.py`         | Live migration of an exec session: output continues through the migration window, final close is the real `exec completed`  | #350   |

## Running

TypeScript:

```
OPENCOMPUTER_API_URL=... OPENCOMPUTER_API_KEY=... \
  npx tsx scripts/integration-tests/01-fork-sync-hibernate.ts
```

Python (requires `httpx` and `websockets`):

```
OPENCOMPUTER_API_URL=... OPENCOMPUTER_API_KEY=... \
  python3 scripts/integration-tests/05-ws-multi-client.py
```

Each script exits 0 on success, 1 on any failure. The Python tests share a
small `_ws_common.py` helper for env-var resolution and sandbox/session
setup; each test file stays focused on the assertion it's checking.
