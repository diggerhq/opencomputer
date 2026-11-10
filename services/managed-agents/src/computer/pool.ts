// The warm pool (work 052, phase 2 "fast first message"): computers that are
// already booted, provisioned and connected, so a new organization claims
// one in seconds instead of waiting two to three minutes for a VM.
//
// A pool computer is an ordinary computer whose identity is a slot id
// `pool-<random>` (names.ts): its own ComputerDurableObject (named by that
// id) runs the same lifecycle at the free size, its resources are named
// `oc-pool-<random>` and tagged `organization=pool`, and its host connects
// with the token derived for that id. This module is the slot table kept by
// one more ComputerDurableObject, named `computer-pool` (the same class, so
// no new Durable Object class and no migration; like the
// `computer-slack-team:<teamId>` link objects it only uses its own table).
//
//   provisioning → warm → claiming → claimed
//        ↑           │        │
//        └───────────┴────────┘  (host gone, or the slot's object refused)
//
// A slot is `warm` once its object reports the host connected (it tells the
// pool on hello; the alarm also asks). The alarm refills to
// COMPUTER_POOL_SIZE, at most MAX_PROVISIONING at a time, retires slots that
// failed or never connected, and retires warm ones above the target. Claims
// are atomic because the pick and the mark happen in one synchronous step of
// this single-threaded object, before any await: two concurrent claims
// never get the same slot.
//
// Work 081: a warm slot also checks Claude setup tokens for the dashboard,
// before the person has a computer (`probe`). Stateless by design: it reads
// the slot table and writes nothing to it, makes one try on one warm slot
// picked at random (never the oldest, which `claim` takes), and its only
// writes are the bounded counters in pool-probe-limits.ts.

import type { AdoptedComputer, LifecycleReply } from "./lifecycle.js";
import { type ProbeOutcome, tokenFingerprint } from "./model-access.js";
import { computerName, newPoolId } from "./names.js";
import { ProbeLimits } from "./pool-probe-limits.js";

export type PoolSlotState = "provisioning" | "warm" | "claiming" | "claimed";

export type PoolSlot = {
  poolId: string;
  prefix: string;
  state: PoolSlotState;
  createdAt: number;
  updatedAt: number;
  claimedBy: string | null;
};

/** What the pool asks of a slot's own ComputerDurableObject. */
export interface PoolSlotComputer {
  /** Creates the pool computer (free size, default disk). */
  start(): Promise<LifecycleReply>;
  /** Its lifecycle state (null: no row), whether its host is connected, and whether that host runs the model proxy. */
  status(): Promise<PoolSlotStatus>;
  /** Hands the computer to an organization if it is ready and connected; null otherwise. */
  release(organizationId: string): Promise<AdoptedComputer | null>;
  /** Deletes the computer, both disks included. */
  retire(): Promise<void>;
  /** Checks a Claude setup token through its host's model proxy (work 081); writes nothing. */
  probe(token: string): Promise<ProbeOutcome>;
}

export type PoolSlotStatus = { state: string | null; connected: boolean; proxy?: boolean };

/** A pool probe's answer, with the pool's state for the `computer.agent_probe` event. */
export interface PoolProbeResult {
  outcome: ProbeOutcome;
  /** Whether a slot was asked: false when refused or no slot was warm. */
  asked: boolean;
  warmSlots: number;
  /** Warm slots whose host runs the model proxy, as of the last alarm (null: not counted yet). */
  slotsWithProxy: number | null;
}

export interface PoolDeps {
  sql: SqlStorage;
  /** COMPUTER_POOL_SIZE. */
  target(): number;
  slot(poolId: string): PoolSlotComputer;
  setAlarm(at: number): Promise<void>;
  now?: () => number;
  /** How long a pool probe may take end to end (default POOL_PROBE_TIMEOUT_MS). */
  probeTimeoutMs?: number;
}

export interface PoolClaim extends AdoptedComputer {
  poolId: string;
}

/** Pool computers created at once; the rest follow on later alarms. */
export const MAX_PROVISIONING = 3;
export const REFILL_INTERVAL_MS = 60_000;
/** A slot not connected by then is retired (a first boot takes about two minutes). */
export const PROVISION_TIMEOUT_MS = 30 * 60_000;
/** A claim whose hand-over never finished (the object was evicted mid-claim). */
const CLAIM_TIMEOUT_MS = 10 * 60_000;
const CLAIMED_RETENTION_MS = 7 * 24 * 3600_000;
const MAX_POOL_SIZE = 200;
/** A slot's own probe gives up after this long (the web waits; about 9 s end to end in every branch). */
export const SLOT_PROBE_TIMEOUT_MS = 8_000;
/** The pool's guard around the slot's answer: the slot's timeout plus the call's own way there and back. */
export const POOL_PROBE_TIMEOUT_MS = SLOT_PROBE_TIMEOUT_MS + 500;

/** COMPUTER_POOL_SIZE as a number: absent, malformed or negative is 0 (no pool). */
export function poolSize(value: string | undefined): number {
  const size = Number(value ?? "0");
  return Number.isInteger(size) && size > 0 ? Math.min(size, MAX_POOL_SIZE) : 0;
}

const SELECT = `SELECT pool_id AS poolId, prefix, state, created_at AS createdAt, updated_at AS updatedAt,
  claimed_by AS claimedBy FROM pool_slots`;

export class ComputerPool {
  private readonly limits: ProbeLimits;
  /** The last alarm's count of warm slots whose host runs the model proxy (memory only). */
  private slotsWithProxy: number | null = null;

  constructor(private readonly deps: PoolDeps) {
    deps.sql.exec(`
      CREATE TABLE IF NOT EXISTS pool_slots (
        pool_id TEXT PRIMARY KEY,
        prefix TEXT NOT NULL,
        state TEXT NOT NULL,
        claimed_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.limits = new ProbeLimits(deps.sql, () => this.now());
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  slots(): PoolSlot[] {
    return [...this.deps.sql.exec<PoolSlot>(`${SELECT} ORDER BY created_at`)];
  }

  private setState(poolId: string, from: PoolSlotState, to: PoolSlotState): void {
    this.deps.sql.exec(
      "UPDATE pool_slots SET state = ?, updated_at = ? WHERE pool_id = ? AND state = ?",
      to,
      this.now(),
      poolId,
      from,
    );
  }

  private drop(poolId: string): void {
    this.deps.sql.exec("DELETE FROM pool_slots WHERE pool_id = ?", poolId);
  }

  /** Makes sure the alarm will look at the pool soon. */
  async kick(): Promise<void> {
    await this.deps.setAlarm(this.now());
  }

  /** A slot's host said hello. */
  async connected(poolId: string): Promise<void> {
    this.setState(poolId, "provisioning", "warm");
  }

  /**
   * Claims a warm computer for an organization; null when there is none
   * (the caller creates one the usual way). The claim path, for latency:
   * this object's synchronous pick, one call to the slot's object (which
   * checks its host is connected and marks its row transferred), and back.
   */
  async claim(organizationId: string): Promise<PoolClaim | null> {
    try {
      for (let tries = 0; tries < 3; tries += 1) {
        // Pick and mark with no await in between: this is the atomic step.
        const slot = [...this.deps.sql.exec<PoolSlot>(`${SELECT} WHERE state = 'warm' ORDER BY created_at LIMIT 1`)][0];
        if (!slot) return null;
        this.deps.sql.exec(
          "UPDATE pool_slots SET state = 'claiming', claimed_by = ?, updated_at = ? WHERE pool_id = ?",
          organizationId,
          this.now(),
          slot.poolId,
        );
        let released: AdoptedComputer | null = null;
        try {
          released = await this.deps.slot(slot.poolId).release(organizationId);
        } catch (error) {
          console.error(JSON.stringify({ level: "error", event: "computer.pool_release_failed", poolId: slot.poolId, message: errorText(error) }));
        }
        if (released) {
          this.setState(slot.poolId, "claiming", "claimed");
          console.log(JSON.stringify({ level: "info", event: "computer.pool_claimed", poolId: slot.poolId, accountId: organizationId }));
          return { ...released, poolId: slot.poolId };
        }
        // Not ready or not connected after all: the alarm looks at it again.
        this.deps.sql.exec(
          "UPDATE pool_slots SET state = 'provisioning', claimed_by = NULL, updated_at = ? WHERE pool_id = ? AND state = 'claiming'",
          this.now(),
          slot.poolId,
        );
      }
      return null;
    } finally {
      // Every claim, served or not, is a reason to refill.
      await this.kick();
    }
  }

  /**
   * Checks a Claude setup token through one warm slot (work 081), for
   * `user` (the dashboard user's id). In order: the user's and the token's
   * counters (`rate_limited`), the breaker (`breaker`), a warm slot picked at
   * random (`no_warm`), then one try with POOL_PROBE_TIMEOUT_MS; the
   * counters are charged only when that try goes out. Writes nothing to
   * `pool_slots`. The token is an argument only: never logged,
   * and a failure carries its class, not its message.
   */
  async probe(token: string, user: string): Promise<PoolProbeResult> {
    const fingerprint = await tokenFingerprint(token);
    const warm = [...this.deps.sql.exec<{ poolId: string }>("SELECT pool_id AS poolId FROM pool_slots WHERE state = 'warm'")];
    const answer = (outcome: ProbeOutcome, asked = false): PoolProbeResult => ({ outcome, asked, warmSlots: warm.length, slotsWithProxy: this.slotsWithProxy });
    if (!this.limits.admit(user, fingerprint)) return answer({ error: "rate_limited" });
    if (this.limits.breakerOpen()) return answer({ error: "breaker" });
    const slot = warm[Math.floor(Math.random() * warm.length)];
    if (!slot) return answer({ error: "no_warm" });
    // Only a probe that leaves counts against the user and the token.
    this.limits.charge(user, fingerprint);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: ProbeOutcome;
    try {
      outcome = await Promise.race([
        this.deps.slot(slot.poolId).probe(token),
        new Promise<ProbeOutcome>((resolve) => {
          timer = setTimeout(() => resolve({ error: "timeout" }), this.deps.probeTimeoutMs ?? POOL_PROBE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // The class only: an RPC error's message is not ours to repeat.
      outcome = { error: "error" };
    } finally {
      clearTimeout(timer);
    }
    if ("status" in outcome) this.limits.record(outcome.status === 401 || outcome.status === 403);
    return answer(outcome, true);
  }

  /** One alarm: reconcile, retire, refill. Returns when to look again (null: nothing to do until kicked). */
  async refill(): Promise<number | null> {
    const now = this.now();
    const target = this.deps.target();
    this.deps.sql.exec("DELETE FROM pool_slots WHERE state = 'claimed' AND updated_at < ?", now - CLAIMED_RETENTION_MS);

    for (const slot of this.slots()) {
      if (slot.state === "provisioning") await this.reconcile(slot, now);
      else if (slot.state === "claiming" && now - slot.updatedAt > CLAIM_TIMEOUT_MS) await this.reconcileClaim(slot);
    }

    // Too many (the target was lowered): retire the newest, provisioning first.
    let live = this.slots().filter((slot) => slot.state === "provisioning" || slot.state === "warm");
    const extra = live.length - target;
    if (extra > 0) {
      const order = [...live].sort((a, b) => (a.state === b.state ? b.createdAt - a.createdAt : a.state === "provisioning" ? -1 : 1));
      for (const slot of order.slice(0, extra)) await this.retire(slot, "above target");
      live = this.slots().filter((slot) => slot.state === "provisioning" || slot.state === "warm");
    }

    await this.gauge(live.filter((slot) => slot.state === "warm"));

    const provisioning = live.filter((slot) => slot.state === "provisioning").length;
    const create = Math.min(target - live.length, MAX_PROVISIONING - provisioning);
    for (let index = 0; index < create; index += 1) {
      const poolId = newPoolId();
      this.deps.sql.exec(
        "INSERT INTO pool_slots (pool_id, prefix, state, created_at, updated_at) VALUES (?, ?, 'provisioning', ?, ?)",
        poolId,
        computerName(poolId),
        now,
        now,
      );
      let reply: LifecycleReply;
      try {
        reply = await this.deps.slot(poolId).start();
      } catch (error) {
        reply = { status: 502, error: errorText(error) };
      }
      if (reply.status >= 400) {
        console.error(JSON.stringify({ level: "error", event: "computer.pool_start_failed", poolId, status: reply.status, message: reply.error }));
        await this.deps.slot(poolId).retire().catch(() => {});
        this.drop(poolId);
        break;
      }
      console.log(JSON.stringify({ level: "info", event: "computer.pool_started", poolId }));
    }

    return target > 0 || this.slots().some((slot) => slot.state !== "claimed") ? now + REFILL_INTERVAL_MS : null;
  }

  /**
   * Work 081: how many warm slots' hosts run the model proxy. If pool VMs
   * come up without it, every dashboard token check degrades to "saved,
   * unchecked", and only this says so. Reads only.
   */
  private async gauge(warm: PoolSlot[]): Promise<void> {
    let withProxy = 0;
    let unknown = 0;
    for (const slot of warm) {
      try {
        if ((await this.deps.slot(slot.poolId).status()).proxy) withProxy += 1;
      } catch {
        unknown += 1;
      }
    }
    this.slotsWithProxy = withProxy;
    console.log(JSON.stringify({ level: "info", event: "computer.pool_gauge", warm: warm.length, withProxy, unknown }));
  }

  /** A provisioning slot: warm if its host is connected, retired if it failed or never connected. */
  private async reconcile(slot: PoolSlot, now: number): Promise<void> {
    let status: PoolSlotStatus;
    try {
      status = await this.deps.slot(slot.poolId).status();
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", event: "computer.pool_status_failed", poolId: slot.poolId, message: errorText(error) }));
      return;
    }
    if (status.state === "ready" && status.connected) return this.setState(slot.poolId, "provisioning", "warm");
    if (status.state === null || status.state === "deleted" || status.state === "transferred") {
      this.drop(slot.poolId);
      return;
    }
    // From the last state change: a warm slot whose host dropped during a claim gets a fresh wait.
    if (status.state === "failed" || now - slot.updatedAt > PROVISION_TIMEOUT_MS) {
      await this.retire(slot, status.state === "failed" ? "failed" : "never connected");
    }
  }

  /** A claim that never finished: the slot's object says whether it was handed over. */
  private async reconcileClaim(slot: PoolSlot): Promise<void> {
    const status = await this.deps.slot(slot.poolId).status().catch(() => null);
    if (!status) return;
    if (status.state === "transferred") {
      // Handed over, but the organization may never have adopted it: an
      // orphan to look at by hand.
      console.error(JSON.stringify({ level: "error", event: "computer.pool_claim_unfinished", poolId: slot.poolId, accountId: slot.claimedBy }));
      this.setState(slot.poolId, "claiming", "claimed");
    } else {
      this.deps.sql.exec(
        "UPDATE pool_slots SET state = 'provisioning', claimed_by = NULL, updated_at = ? WHERE pool_id = ?",
        this.now(),
        slot.poolId,
      );
    }
  }

  private async retire(slot: PoolSlot, reason: string): Promise<void> {
    console.log(JSON.stringify({ level: "info", event: "computer.pool_retired", poolId: slot.poolId, reason }));
    try {
      await this.deps.slot(slot.poolId).retire();
      this.drop(slot.poolId);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "computer.pool_retire_failed", poolId: slot.poolId, message: errorText(error) }));
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
