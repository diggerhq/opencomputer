# Snapshot Corruption Stress Test — Design (v3)

**Goal:** Reproduce and disprove the customer's exact failure: "restore from snapshot →
git segfaults → snapshot got corrupted." Run 1000 restores from freshly-created
snapshots with zero corruption.

**Target:** Production cluster (Azure East US 2)
**Client:** TypeScript SDK
**Concurrency limit:** 5 simultaneous sandboxes (API limit)
**Estimated runtime:** ~55 minutes

---

## Customer's Scenario

From the customer report:
> "git segfaults happened 1st attempt at 10 run on the bench when recreating
> from snapshot 1st time. looks like snapshot got corrupted."
>
> "what number would make sense? 1000 in a row and we can restore checkpoint
> would really help"

The workflow:
1. Stand up sandbox, install tools, configure environment
2. Create snapshot/checkpoint from that sandbox
3. Restore from snapshot → run benchmark (time to first token, write files, git commit)
4. **On first restore, git segfaulted** — snapshot was corrupted

## How Corruption Happens Here

**Checkpoint creation does:**
1. `savevm` via QMP — pauses VM briefly, writes memory+device state into qcow2
2. VM resumes — QEMU starts modifying qcow2 again
3. Copy qcow2 files to cache directory (for fast forking)
4. Upload qcow2 to S3 (for cross-worker restores)

**Race:** If the VM resumes (step 2) while the copy (step 3) is still running,
the cached qcow2 has mixed blocks — some from the snapshot point-in-time, some
from post-resume. This is the same pattern as Vector 1 (hibernate archive race)
but applied to checkpoint creation.

**Two corruption scenarios:**

| Scenario | What's corrupted | Behavior | Intermittent? |
|---|---|---|---|
| A: Cache copy races with VM resume | Local checkpoint cache | Every restore from this checkpoint fails identically | No — deterministic per-snapshot. But snapshot creation is racy, so some snapshots are fine, some aren't. |
| B: S3 upload corrupted, local cache fine | S3 archive | Restores on same worker (local cache) work. Restores on different worker (S3 download) fail. | Yes — depends on which worker handles the restore. |

The customer likely hit Scenario A: snapshot created with corrupted cache → first
restore immediately segfaults.

## Test Design (v3)

**Directly reproduce the customer's workflow at 1000x scale.**

### Structure: 5 rounds × 200 restores = 1000 total

```
Round 1 (restores 1-200):
  Setup:
    1. Create sandbox
    2. Write marker files + record SHA256
    3. Run "git init && git add . && git commit" — establish git state
    4. Create checkpoint, wait for ready
    5. Destroy source sandbox (force restores to use cache/S3, not same VM)

  Restore loop (200 times, concurrency 5):
    6. Create sandbox from checkpoint
    7. Run "git status" — segfault = corruption
    8. Run "git log --oneline" — verify git state
    9. Verify marker file SHA256
    10. Destroy

Round 2 (restores 201-400): same with fresh snapshot
...
Round 5 (restores 801-1000): same with fresh snapshot
```

### Why 5 rounds, not 1 round of 1000?

- **Tests snapshot CREATION 5 times.** If the creation race exists, some of the
  5 snapshots might be corrupted. A single snapshot could get lucky (no race) and
  pass 1000 restores while the bug still exists.
- **Each round creates a fresh checkpoint.** This exercises the qcow2 copy path
  5 separate times, increasing the chance of hitting the creation race.
- **200 restores per snapshot is enough** to detect both Scenario A (fails immediately)
  and Scenario B (fails on cross-worker restores, intermittent).

### What each restore verifies

1. **`git status`** — segfault = corrupted binary in qcow2 (the customer's exact failure)
2. **`git log --oneline`** — verifies git object database is intact
3. **Marker file SHA256** — verifies arbitrary file data survives checkpoint/restore
4. **Exit codes** — any non-zero exit = something wrong

### Why this catches the bug

If the checkpoint's qcow2 copy is corrupted (Scenario A):
- **Every single restore** in that round fails — git segfaults, SHA256 mismatches
- Detected immediately on restore #1

If the S3 upload is corrupted but local cache is fine (Scenario B):
- Restores on the same worker succeed (local cache)
- Restores on different workers fail (S3 download)
- With 200 restores at concurrency 5, some will land on different workers
- Detected intermittently within the round

If nothing is corrupted:
- All 1000 restores pass
- Customer deliverable: "5 independently-created snapshots, 200 restores each,
  1000 total, 0 corruption, 0 segfaults"

---

## CLI Interface

```
source .env && npx tsx scripts/stress-snapshot-corruption.ts \
  --restores 1000 \
  --rounds 5 \
  --concurrency 5 \
  --marker-size 5 \
  -o report.json
```

| Flag | Default | Description |
|---|---|---|
| `-n, --restores` | 1000 | Total number of restores across all rounds |
| `-r, --rounds` | 5 | Number of independently-created snapshots |
| `-c, --concurrency` | 5 | Max simultaneous sandbox restores |
| `--marker-size` | 5 | Marker file size in MB |
| `--api-key` | `$OPENCOMPUTER_API_KEY` | API key |
| `--api-url` | `$OPENCOMPUTER_API_URL` | API URL |
| `-o, --output` | — | Write JSON report to file |

Restores are distributed evenly: `--restores 1000 --rounds 5` = 200 per round.

---

## Data Model

```typescript
interface RestoreResult {
  index: number;            // 0-199 within the round
  sandboxId: string;
  gitStatusOk: boolean;     // git status exited 0, no segfault
  gitLogOk: boolean;        // git log returned expected output
  markerVerified: boolean;  // SHA256 match
  markerActualSha256?: string;
  createMs: number;
  verifyMs: number;
  error?: string;
}

interface RoundResult {
  round: number;
  sourceSandboxId: string;
  checkpointId: string;
  markerSha256: string;
  setupMs: number;          // time to create source + checkpoint
  restores: RestoreResult[];
  totalRestores: number;
  corrupted: number;        // git fail or SHA256 mismatch
  errored: number;          // infra errors (timeout, 500)
}

interface TestReport {
  startedAt: string;
  completedAt: string;
  config: {
    restores: number;
    rounds: number;
    concurrency: number;
    markerSizeMB: number;
  };
  rounds: RoundResult[];
  summary: {
    totalRestores: number;
    totalCorrupted: number;
    totalErrored: number;
    totalDurationMs: number;
    corruption: boolean;
  };
}
```

---

## Verification

**Per-restore checks:**
1. `git status` exits 0 (no segfault, exit code 139 = SIGSEGV)
2. `git log --oneline` returns expected commit message
3. Marker file SHA256 matches original

**Corruption = any of:**
- git exits with signal 11 (SIGSEGV) → binary corrupted in qcow2
- git output doesn't match expected → git object database corrupted
- SHA256 mismatch → file data corrupted

**Pass criteria:**
- `totalCorrupted == 0` across all 1000 restores
- `totalErrored < 10%` (infra errors like timeouts are tolerable)

---

## Timing Estimate

| Step | Time | Count |
|---|---|---|
| Create source sandbox | ~10s | 5 |
| Write marker + git init/commit | ~5s | 5 |
| Create checkpoint + wait ready | ~30s | 5 |
| **Setup per round** | **~45s** | **5 rounds = ~4 min** |
| Create from checkpoint | ~10s | 1000 |
| Verify (git + SHA256) | ~3s | 1000 |
| Destroy | ~1s | 1000 |
| **Per restore** | **~14s** | |
| **200 restores / 5 concurrent** | **~9 min per round** | |
| **Total** | **~50 min** | |

---

## Limitations

- **Snapshot creation race is probabilistic.** 5 rounds gives 5 chances to hit
  the race during creation. If the race window is very narrow, we might not
  trigger it. The internal stress tests (which run on the worker) are better
  suited to testing the creation path with precise timing.
- **Cross-worker restores depend on scheduler.** At concurrency 5, most restores
  likely hit the same worker (which has the local cache). Scenario B corruption
  (bad S3, good cache) may not be detected at low concurrency. Higher concurrency
  or a `forceS3` test flag would improve coverage.
- **Git segfault is a symptom, not a root cause.** If git works but other
  binaries are silently corrupted, we wouldn't detect it. The SHA256 marker
  check covers arbitrary file data as a second verification layer.
