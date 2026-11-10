// An organization's computer, as its ComputerDurableObject keeps it (work
// 052; ported from dash-cal src/computer-lifecycle.ts and extended with
// parking, decision 10): one `computer` row and a state machine driven by the
// Durable Object's alarm.
//
//   provisioning → ready ⇄ resizing
//                  ready → parking → parked → waking → ready
//   any → deleting → deleted            failed → (create again) → provisioning
//
// Warm pool (pool.ts): a pool computer's own row goes ready → transferred
// when an organization claims it, after which that object never touches the
// computer again; the claiming organization's row starts at `ready`
// (`adopt`), with the pool computer's prefix, size and disks, and moves the
// resources' tags from `pool` to itself on its next alarm (`tags_pending`).
//
// Provisioning and waking are the same idempotent step: each alarm looks at
// what exists (data disk, NIC, VM), PUTs what is missing and polls
// provisioningState, so a retry or a second `create` just looks again. The VM
// is created from the image the first time, and attached to its kept OS disk
// after a park. Transient cloud errors back off and retry; a refusal (4xx), a
// failed VM or too many attempts leave the row `failed` with its error.
// Parking deletes the VM and NIC and keeps both disks.
//
// Every cloud call names the computer by its stored resource name prefix
// (`resource_prefix`), not by a name derived from the organization id at
// each call: a computer can change hands and keep its name. Rows from
// before the column existed have it NULL and use the derived name, which is
// what they were created with.

import type { CloudResource, CloudResourceKind, CloudTarget } from "./cloud-contract.js";
import { CloudError, type ComputerCloud } from "./cloud.js";
import { ComputersNotConfigured, type PublicComputer, type PublicComputerState, publicError, sizeShape } from "./config.js";
import { POOL_TAG, computerName, ownerTag } from "./names.js";

export type ComputerState =
  | "provisioning"
  | "ready"
  | "resizing"
  | "parking"
  | "parked"
  | "waking"
  | "failed"
  | "deleting"
  | "deleted"
  /** A pool computer handed to an organization: no longer this row's to manage. */
  | "transferred";

export interface LifecycleDeps {
  sql: SqlStorage;
  /** The cloud; throws ComputersNotConfigured when there is none. */
  cloud(): ComputerCloud;
  /** Edge settings still missing (host token key, gateway URL, bindings). */
  missingConfig(): string[];
  /** The organization's host token and the URL its host dials, for a VM's first boot. */
  hostToken(organizationId: string): Promise<string>;
  gatewayUrl(organizationId: string): string;
  setAlarm(at: number): Promise<void>;
  hostConnected(): boolean;
  /** The computer became ready (created or woken): counts as activity, so it is not parked at once. */
  onReady?(): void;
  now?: () => number;
  sshPublicKey?: () => Promise<string>;
}

export interface CreateOptions {
  size: string;
  diskGiB: number;
  zone: string;
  /** Resource name prefix; default the one derived from the organization id. */
  prefix?: string;
}

/** A warm pool computer as the claiming organization's row adopts it. */
export interface AdoptedComputer {
  prefix: string;
  size: string;
  diskGiB: number;
  zone: string;
  sshPublicKey: string;
  /** The pool slot id it was built under. */
  poolSlot: string;
}

/** An HTTP-shaped answer, so routes can pass it through. */
export interface LifecycleReply {
  status: number;
  error?: string;
}

export type ComputerRow = {
  organizationId: string;
  state: ComputerState;
  size: string;
  diskGiB: number;
  zone: string;
  sshPublicKey: string;
  attempts: number;
  lastError: string | null;
  /** A wake was asked for while parking: wake as soon as parked. */
  wakeAfterPark: number;
  /** Delete the data disk too (deleting only). */
  deleteDisk: number;
  /** A host has said hello from this computer: its OS disk is provisioned and may be attached on wake. */
  osInitialized: number;
  /** Created again after `failed`: a VM left in Failed is deleted and built again, not PUT over. */
  replaceFailedVm: number;
  /** Times woken; a notice is posted once per thread per wake. */
  wakes: number;
  /** Resource name prefix; null on rows from before it was stored (the derived name). */
  resourcePrefix: string | null;
  /** The warm pool slot this computer was claimed from, if any. */
  poolSlot: string | null;
  /** Claimed from the pool and its resources still tagged `pool`: the alarm moves them. */
  tagsPending: number;
  createdAt: number;
  updatedAt: number;
};

/** Not worth retrying: the request itself is wrong, or a resource is not ours. */
class Fatal extends Error {}

export const POLL_MS = 15_000;
const MAX_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const MAX_DISK_GIB = 65_536;

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

const SELECT = `SELECT organization_id AS organizationId, state, size, disk_gib AS diskGiB, zone,
  ssh_public_key AS sshPublicKey, attempts, last_error AS lastError, wake_after_park AS wakeAfterPark,
  delete_disk AS deleteDisk, os_initialized AS osInitialized, replace_failed_vm AS replaceFailedVm, wakes,
  resource_prefix AS resourcePrefix, pool_slot AS poolSlot, tags_pending AS tagsPending, created_at AS createdAt,
  updated_at AS updatedAt FROM computer WHERE id = 1`;

const PUBLIC_STATE: Record<Exclude<ComputerState, "deleted" | "transferred">, PublicComputerState> = {
  provisioning: "provisioning",
  ready: "ready",
  // The VM exists throughout a resize; it restarts on its new size.
  resizing: "ready",
  parking: "parked",
  parked: "parked",
  waking: "waking",
  failed: "failed",
  deleting: "deleting",
};

function nvmeSize(size: string): boolean {
  return /_v[67]$/i.test(size);
}

function validSize(size: string): boolean {
  return /^Standard_[A-Za-z0-9_]+$/.test(size);
}

export class ComputerLifecycle {
  constructor(private readonly deps: LifecycleDeps) {
    deps.sql.exec(`
      CREATE TABLE IF NOT EXISTS computer (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        organization_id TEXT NOT NULL,
        state TEXT NOT NULL,
        size TEXT NOT NULL,
        disk_gib INTEGER NOT NULL,
        zone TEXT NOT NULL,
        ssh_public_key TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        wake_after_park INTEGER NOT NULL DEFAULT 0,
        delete_disk INTEGER NOT NULL DEFAULT 0,
        os_initialized INTEGER NOT NULL DEFAULT 0,
        replace_failed_vm INTEGER NOT NULL DEFAULT 0,
        wakes INTEGER NOT NULL DEFAULT 0,
        resource_prefix TEXT,
        pool_slot TEXT,
        tags_pending INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // Columns added after the table first shipped (no migration step: NULL means "derive").
    for (const column of ["resource_prefix TEXT", "pool_slot TEXT", "tags_pending INTEGER NOT NULL DEFAULT 0"]) {
      try {
        deps.sql.exec(`ALTER TABLE computer ADD COLUMN ${column}`);
      } catch {
        // Already there.
      }
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  row(): ComputerRow | undefined {
    return [...this.deps.sql.exec<ComputerRow>(SELECT)][0];
  }

  /** What every cloud call names: the organization (tags, host id) and the stored name prefix. */
  target(row: ComputerRow): CloudTarget {
    return { organizationId: row.organizationId, prefix: row.resourcePrefix ?? computerName(row.organizationId) };
  }

  /** The dashboard's view; null when there is no computer. */
  view(): PublicComputer | null {
    const row = this.row();
    if (!row || row.state === "deleted" || row.state === "transferred") return null;
    return {
      state: PUBLIC_STATE[row.state],
      connected: this.deps.hostConnected(),
      ...sizeShape(row.size),
      diskGiB: row.diskGiB,
      lastError: row.state === "failed" ? publicError(row.lastError) : null,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  /** Every setting still missing, edge and platform; empty when computers can be created. */
  async missingConfig(): Promise<string[]> {
    const missing = this.deps.missingConfig();
    if (missing.includes("RUNTIMES") || missing.includes("COMPUTERS")) return missing;
    try {
      return [...missing, ...(await this.deps.cloud().missing())];
    } catch (error) {
      return [...missing, `platform (${message(error)})`];
    }
  }

  /**
   * Creates the computer if there is none, wakes a parked one, retries a
   * failed one; otherwise leaves it as it is. Idempotent.
   */
  async create(organizationId: string, options: CreateOptions): Promise<LifecycleReply> {
    const existing = this.row();
    if (existing && existing.organizationId !== organizationId) {
      return { status: 409, error: "this computer belongs to another organization" };
    }
    if (existing?.state === "transferred") return { status: 409, error: "this computer was handed to an organization" };
    if (existing?.state === "parked" || existing?.state === "parking") {
      await this.wake();
      return { status: 202 };
    }
    if (existing && existing.state !== "failed" && existing.state !== "deleted") {
      if (existing.state === "deleting") return { status: 409, error: "the computer is being deleted" };
      if (existing.state === "provisioning" || existing.state === "waking") await this.deps.setAlarm(this.now());
      return { status: 200 };
    }
    if (!validSize(options.size)) return { status: 500, error: `invalid size configured: ${options.size}` };
    if (!Number.isInteger(options.diskGiB) || options.diskGiB < 1 || options.diskGiB > MAX_DISK_GIB) {
      return { status: 500, error: `invalid disk size configured: ${options.diskGiB}` };
    }
    const missing = await this.missingConfig();
    if (missing.length) return { status: 503, error: new ComputersNotConfigured(missing).message };
    // Generated before reading the row again: nothing may interleave between that read and the write.
    const sshPublicKey = await (this.deps.sshPublicKey ?? throwawaySshPublicKey)();
    const now = this.now();
    const row = this.row();
    if (row && row.state !== "failed" && row.state !== "deleted") return { status: 200 };
    if (row) {
      // Again after a failure or a delete: same names, so kept disks are reused.
      // The size is the configured one again (a failure may be the size's
      // capacity); the disk stays what it was unless the computer was deleted.
      this.deps.sql.exec(
        `UPDATE computer SET state = 'provisioning', attempts = 0, last_error = NULL, wake_after_park = 0,
           delete_disk = 0, replace_failed_vm = 1, updated_at = ?,
           size = ?,
           disk_gib = CASE WHEN state = 'deleted' THEN ? ELSE disk_gib END
         WHERE id = 1`,
        now,
        options.size,
        options.diskGiB,
      );
    } else {
      this.deps.sql.exec(
        `INSERT INTO computer (id, organization_id, state, size, disk_gib, zone, ssh_public_key, resource_prefix, created_at, updated_at)
         VALUES (1, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?)`,
        organizationId,
        options.size,
        options.diskGiB,
        options.zone,
        sshPublicKey,
        options.prefix ?? computerName(organizationId),
        now,
        now,
      );
    }
    await this.deps.setAlarm(now);
    return { status: 202 };
  }

  /**
   * Wakes a parked computer (or one being parked, once it is). True if it is
   * now waking or will be. With `size`, the VM comes back on that size (the
   * organization's plan's: a downsize happens here, never on a running
   * computer); a size on another disk controller is ignored.
   */
  async wake(size?: string): Promise<boolean> {
    const row = this.row();
    if (!row) return false;
    if (size && size !== row.size && (row.state === "parked" || row.state === "parking")) {
      if (validSize(size) && nvmeSize(size) === nvmeSize(row.size)) {
        this.deps.sql.exec("UPDATE computer SET size = ?, updated_at = ? WHERE id = 1", size, this.now());
      } else {
        console.warn(JSON.stringify({ level: "warn", event: "computer.wake_size_ignored", from: row.size, to: size }));
      }
    }
    if (row.state === "parking") {
      this.deps.sql.exec("UPDATE computer SET wake_after_park = 1 WHERE id = 1 AND state = 'parking'");
      return true;
    }
    if (row.state !== "parked") return false;
    this.deps.sql.exec(
      `UPDATE computer SET state = 'waking', attempts = 0, last_error = NULL, wakes = wakes + 1, updated_at = ?
       WHERE id = 1 AND state = 'parked'`,
      this.now(),
    );
    await this.deps.setAlarm(this.now());
    return true;
  }

  /** Starts parking a ready computer: its VM and NIC go, its disks stay. */
  async park(): Promise<boolean> {
    const row = this.row();
    if (row?.state !== "ready") return false;
    this.transition("ready", "parking", null);
    await this.deps.setAlarm(this.now());
    return true;
  }

  /**
   * A pool computer's own row hands it over: ready → transferred, and what
   * the claiming organization's row needs. Null when it is not a ready
   * computer (the caller checks that its host is connected).
   */
  transfer(): AdoptedComputer | null {
    const row = this.row();
    if (row?.state !== "ready") return null;
    this.transition("ready", "transferred", null);
    return {
      prefix: this.target(row).prefix,
      size: row.size,
      diskGiB: row.diskGiB,
      zone: row.zone,
      sshPublicKey: row.sshPublicKey,
      poolSlot: row.organizationId,
    };
  }

  /**
   * The organization claimed a warm pool computer: its row starts `ready`,
   * on the pool computer's resources (prefix, size, disks), already through
   * first boot. The tags move on the alarm set here, so the claim answers
   * without waiting for the cloud. False when the organization already has
   * a row (the caller only claims when it has none).
   */
  async adopt(organizationId: string, computer: AdoptedComputer): Promise<boolean> {
    if (this.row()) return false;
    const now = this.now();
    this.deps.sql.exec(
      `INSERT INTO computer (id, organization_id, state, size, disk_gib, zone, ssh_public_key, os_initialized,
         resource_prefix, pool_slot, tags_pending, created_at, updated_at)
       VALUES (1, ?, 'ready', ?, ?, ?, ?, 1, ?, ?, 1, ?, ?)`,
      organizationId,
      computer.size,
      computer.diskGiB,
      computer.zone,
      computer.sshPublicKey,
      computer.prefix,
      computer.poolSlot,
      now,
      now,
    );
    this.deps.onReady?.();
    await this.deps.setAlarm(now);
    return true;
  }

  /** A host said hello: its OS disk has been through first boot, so a wake may attach it. */
  noteHostSeen(): void {
    this.deps.sql.exec("UPDATE computer SET os_initialized = 1 WHERE id = 1 AND os_initialized = 0");
  }

  /** CPU and memory: the VM restarts on the new size, disks stay. A parked computer takes it on waking. */
  async resize(size: string): Promise<LifecycleReply> {
    const row = this.row();
    if (!row || row.state === "deleted" || row.state === "transferred") return { status: 404, error: "no computer" };
    if (!validSize(size)) return { status: 400, error: `invalid size ${size}` };
    if (size === row.size) return { status: 200 };
    // The OS finds its disks by controller: NVMe (v6/v7) and SCSI sizes do not mix.
    if (nvmeSize(size) !== nvmeSize(row.size)) return { status: 400, error: `${size} uses another disk controller than ${row.size}` };
    if (row.state === "parked") {
      this.deps.sql.exec("UPDATE computer SET size = ?, updated_at = ? WHERE id = 1", size, this.now());
      return { status: 200 };
    }
    if (row.state !== "ready") return { status: 409, error: `the computer is ${row.state}` };
    try {
      await this.deps.cloud().resizeVm(this.target(row), size);
    } catch (error) {
      return { status: 502, error: message(error) };
    }
    this.deps.sql.exec(
      "UPDATE computer SET state = 'resizing', size = ?, attempts = 0, last_error = NULL, updated_at = ? WHERE id = 1",
      size,
      this.now(),
    );
    await this.deps.setAlarm(this.now());
    return { status: 202 };
  }

  /** Disk, online; it can only grow. The VM grows its filesystem itself. */
  async growDisk(diskGiB: number): Promise<LifecycleReply> {
    const row = this.row();
    if (!row || row.state === "deleted" || row.state === "transferred") return { status: 404, error: "no computer" };
    if (!Number.isInteger(diskGiB) || diskGiB > MAX_DISK_GIB) return { status: 400, error: `invalid disk size ${diskGiB}` };
    if (diskGiB < row.diskGiB) return { status: 400, error: `disks cannot shrink: ${row.diskGiB} GiB now, ${diskGiB} GiB asked` };
    if (!["ready", "resizing", "parked"].includes(row.state)) return { status: 409, error: `the computer is ${row.state}` };
    if (diskGiB === row.diskGiB) return { status: 200 };
    try {
      await this.deps.cloud().growDataDisk(this.target(row), diskGiB);
    } catch (error) {
      return { status: 502, error: message(error) };
    }
    this.deps.sql.exec("UPDATE computer SET disk_gib = ?, updated_at = ? WHERE id = 1", diskGiB, this.now());
    return { status: 200 };
  }

  /** Deletes the VM, NIC and OS disk; the data disk only with `deleteDisk`. */
  async delete(options: { deleteDisk?: boolean } = {}): Promise<LifecycleReply> {
    const row = this.row();
    if (!row || row.state === "deleted" || row.state === "transferred") return { status: 404, error: "no computer" };
    this.deps.sql.exec(
      "UPDATE computer SET state = 'deleting', delete_disk = ?, attempts = 0, last_error = NULL, updated_at = ? WHERE id = 1",
      options.deleteDisk ? 1 : 0,
      this.now(),
    );
    await this.deps.setAlarm(this.now());
    return { status: 202 };
  }

  /** One step of whatever the computer is doing; the Durable Object's alarm calls it. */
  async tick(): Promise<void> {
    const row = this.row();
    if (!row) return;
    if (row.state === "ready" && row.tagsPending) return this.moveTags(row);
    let next: number | null;
    try {
      if (row.state === "provisioning" || row.state === "waking") next = await this.ensureRunning(row);
      else if (row.state === "resizing") next = await this.awaitResize(row);
      else if (row.state === "parking") next = await this.teardown(row, ["vm", "nic"], "parked");
      else if (row.state === "deleting") {
        next = await this.teardown(row, ["vm", "nic", "osDisk", ...(row.deleteDisk ? (["dataDisk"] as const) : [])], "deleted");
      } else return;
      this.deps.sql.exec("UPDATE computer SET attempts = 0 WHERE id = 1 AND state = ?", row.state);
    } catch (error) {
      const text = message(error);
      const attempts = row.attempts + 1;
      const fatal =
        error instanceof Fatal ||
        error instanceof ComputersNotConfigured ||
        (error instanceof CloudError && !error.retryable);
      console.error(JSON.stringify({ level: "error", event: "computer.lifecycle_error", state: row.state, attempts, fatal, message: text }));
      if (fatal || attempts >= MAX_ATTEMPTS) {
        this.transition(row.state, "failed", text);
        return;
      }
      this.deps.sql.exec(
        "UPDATE computer SET attempts = ?, last_error = ?, updated_at = ? WHERE id = 1 AND state = ?",
        attempts,
        text,
        this.now(),
        row.state,
      );
      next = backoffMs(attempts);
    }
    if (next !== null) await this.deps.setAlarm(this.now() + next);
  }

  /**
   * A claimed pool computer's resources still say `organization=pool`: move
   * them to the organization. It runs fine meanwhile (`ours` accepts the
   * pool tag while `tags_pending`), so failures only retry with backoff and
   * then stop with an error in the logs, leaving the flag set; they never
   * fail the computer.
   */
  private async moveTags(row: ComputerRow): Promise<void> {
    try {
      await this.deps.cloud().claimTags(this.target(row));
      this.deps.sql.exec("UPDATE computer SET tags_pending = 0, attempts = 0, updated_at = ? WHERE id = 1", this.now());
      console.log(JSON.stringify({ level: "info", event: "computer.pool_tags_moved", accountId: row.organizationId, poolSlot: row.poolSlot }));
    } catch (error) {
      const attempts = row.attempts + 1;
      const fatal = error instanceof ComputersNotConfigured || (error instanceof CloudError && !error.retryable);
      console.error(
        JSON.stringify({ level: "error", event: "computer.pool_tags_failed", accountId: row.organizationId, attempts, fatal, message: message(error) }),
      );
      const giveUp = fatal || attempts >= MAX_ATTEMPTS;
      this.deps.sql.exec("UPDATE computer SET attempts = ? WHERE id = 1", giveUp ? 0 : attempts);
      if (giveUp) return;
      await this.deps.setAlarm(this.now() + backoffMs(attempts));
    }
  }

  /** Data disk, NIC, VM: whatever is missing is PUT, then polled until it succeeded. */
  private async ensureRunning(row: ComputerRow): Promise<number | null> {
    const cloud = this.deps.cloud();
    const org = row.organizationId;
    const target = this.target(row);

    let disk = this.ours(row, await cloud.get(target, "dataDisk"), "data disk");
    disk ??= await cloud.putDataDisk(target, { diskGiB: row.diskGiB, zone: row.zone });
    if (!succeeded(disk)) return POLL_MS;

    let nic = this.ours(row, await cloud.get(target, "nic"), "network interface");
    nic ??= await cloud.putNic(target);
    if (!succeeded(nic)) return POLL_MS;

    let vm = this.ours(row, await cloud.get(target, "vm"), "VM");
    if (vm?.provisioningState === "Failed" && row.replaceFailedVm) {
      // A failed VM left from an earlier try: delete it and build it again
      // rather than PUT over it.
      await cloud.delete(target, "vm");
      return POLL_MS;
    }
    if (row.replaceFailedVm && vm?.provisioningState !== "Deleting") {
      this.deps.sql.exec("UPDATE computer SET replace_failed_vm = 0 WHERE id = 1");
    }
    if (vm?.provisioningState === "Deleting") return POLL_MS;
    if (!vm) {
      const osDisk = this.ours(row, await cloud.get(target, "osDisk"), "OS disk", { allowUntagged: true });
      if (osDisk && !row.osInitialized) {
        // An OS disk that never booted a host (a first boot that failed):
        // it is not worth keeping, and attaching it would boot nothing.
        if (osDisk.provisioningState !== "Deleting") await cloud.delete(target, "osDisk");
        return POLL_MS;
      }
      vm = osDisk
        ? await cloud.putVm(target, { size: row.size, zone: row.zone, mode: "attach", sshPublicKey: row.sshPublicKey })
        : await cloud.putVm(target, {
            size: row.size,
            zone: row.zone,
            mode: "create",
            sshPublicKey: row.sshPublicKey,
            gatewayUrl: this.deps.gatewayUrl(org),
            hostToken: await this.deps.hostToken(org),
          });
    }
    const state = vm.provisioningState;
    if (state === "Failed") throw new Fatal(await this.vmFailure(target));
    if (state !== "Succeeded") return POLL_MS;
    // The OS disk a VM PUT created carries no tags: tag it, so it is
    // recognisably this organization's while the computer is parked.
    try {
      const osDisk = await cloud.get(target, "osDisk");
      if (osDisk && !osDisk.organization) await cloud.tagOsDisk(target);
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", event: "computer.os_disk_tag_failed", message: message(error) }));
    }
    this.transition(row.state, "ready", null);
    this.deps.onReady?.();
    return null;
  }

  private async awaitResize(row: ComputerRow): Promise<number | null> {
    const vm = this.ours(row, await this.deps.cloud().get(this.target(row), "vm"), "VM");
    if (!vm) throw new Fatal("the VM no longer exists");
    if (vm.provisioningState === "Failed") throw new Fatal(await this.vmFailure(this.target(row)));
    if (vm.provisioningState !== "Succeeded" || vm.vmSize !== row.size) return POLL_MS;
    this.transition("resizing", "ready", null);
    // Messages queued during the restart go now.
    this.deps.onReady?.();
    return null;
  }

  /** Each resource in order, waiting for the one before to be gone: the VM holds the NIC and disks. */
  private async teardown(row: ComputerRow, kinds: CloudResourceKind[], to: "parked" | "deleted"): Promise<number | null> {
    const cloud = this.deps.cloud();
    for (const kind of kinds) {
      const resource = this.ours(row, await cloud.get(this.target(row), kind), kind, { allowUntagged: kind === "osDisk" });
      if (!resource) continue;
      if (resource.provisioningState !== "Deleting") await cloud.delete(this.target(row), kind);
      return POLL_MS;
    }
    this.transition(row.state, to, null);
    if (to === "parked" && row.wakeAfterPark) {
      this.deps.sql.exec("UPDATE computer SET wake_after_park = 0 WHERE id = 1");
      await this.wake();
    }
    return null;
  }

  /** A resource under our name that another organization's tag claims is not ours to change. */
  private ours(
    row: ComputerRow,
    resource: CloudResource | null,
    what: string,
    options: { allowUntagged?: boolean } = {},
  ): CloudResource | null {
    if (!resource) return null;
    const owner = resource.organization;
    if (owner === ownerTag(row.organizationId) || (!owner && options.allowUntagged)) return resource;
    // Claimed from the warm pool, tags not moved yet.
    if (owner === POOL_TAG && row.tagsPending) return resource;
    throw new Fatal(`${what} is tagged for ${owner ?? "no organization"}, not ${ownerTag(row.organizationId)}`);
  }

  private async vmFailure(target: CloudTarget): Promise<string> {
    try {
      const vm = await this.deps.cloud().get(target, "vm", { instanceView: true });
      if (vm?.failure) return `VM provisioning failed: ${vm.failure}`;
    } catch {
      // The plain message below is enough.
    }
    return "VM provisioning failed";
  }

  private transition(from: ComputerState, to: ComputerState, error: string | null): void {
    this.deps.sql.exec(
      "UPDATE computer SET state = ?, last_error = ?, updated_at = ? WHERE id = 1 AND state = ?",
      to,
      error,
      this.now(),
      from,
    );
  }
}

function succeeded(resource: CloudResource): boolean {
  return resource.provisioningState === "Succeeded";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A fresh RSA public key in OpenSSH format; the private key is never exported. */
export async function throwawaySshPublicKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return sshRsaPublicKey(base64UrlToBytes(jwk.e ?? ""), base64UrlToBytes(jwk.n ?? ""));
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** RFC 4253 `ssh-rsa` key blob from the exponent and modulus. */
export function sshRsaPublicKey(exponent: Uint8Array, modulus: Uint8Array): string {
  const field = (bytes: Uint8Array) => {
    const out = new Uint8Array(4 + bytes.length);
    new DataView(out.buffer).setUint32(0, bytes.length);
    out.set(bytes, 4);
    return out;
  };
  const mpint = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const trimmed = bytes.slice(start);
    return field((trimmed[0] ?? 0) & 0x80 ? Uint8Array.of(0, ...trimmed) : trimmed);
  };
  const parts = [field(new TextEncoder().encode("ssh-rsa")), mpint(exponent), mpint(modulus)];
  const blob = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    blob.set(part, offset);
    offset += part.length;
  }
  let binary = "";
  for (const byte of blob) binary += String.fromCharCode(byte);
  return `ssh-rsa ${btoa(binary)} opencomputer-unused`;
}
