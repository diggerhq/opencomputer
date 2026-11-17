import { beforeEach, describe, expect, it } from "vitest";

import type { CloudResource, CloudResourceKind, CloudTarget } from "../src/computer/cloud-contract.js";
import { CloudError, type ComputerCloud } from "../src/computer/cloud.js";
import { CAPACITY_ERROR } from "../src/computer/config.js";
import { ComputerLifecycle, type LifecycleDeps, POLL_MS, backoffMs, readAttempt } from "../src/computer/lifecycle.js";
import { sqlStorage } from "./fixtures/computer-sql.js";

const ORG = "org_test";

/**
 * Resources by kind. A PUT creates one in `Creating`; the next GET moves it
 * to `vmOutcome` (VM) or Succeeded. DELETE marks it Deleting and the next GET
 * finds it gone. Creating a VM from the image creates its (untagged) OS disk.
 */
class FakeCloud implements ComputerCloud {
  resources = new Map<CloudResourceKind, CloudResource>();
  calls: string[] = [];
  /** The resource name prefix of every call after `check`. */
  prefixes: string[] = [];
  vmPuts: Array<{ mode: string; size: string; hostToken?: string; gatewayUrl?: string }> = [];
  vmOutcome: "Succeeded" | "Failed" = "Succeeded";
  /** Placements (`size@zone`) whose VM ends Failed with ZonalAllocationFailed. */
  noCapacity = new Set<string>();
  /** Where every VM PUT asked to be. */
  vmPlacements: string[] = [];
  failNext?: CloudError;
  missingNames: string[] = [];

  private check(call: string, target?: CloudTarget) {
    this.calls.push(call);
    if (target) this.prefixes.push(target.prefix);
    const failure = this.failNext;
    this.failNext = undefined;
    if (failure) throw failure;
  }

  async missing() {
    return this.missingNames;
  }

  async get(target: CloudTarget, kind: CloudResourceKind, options: { instanceView?: boolean } = {}) {
    this.check(`GET ${kind}${options.instanceView ? "+view" : ""}`, target);
    const resource = this.resources.get(kind);
    if (!resource) return null;
    if (resource.provisioningState === "Deleting") {
      this.resources.delete(kind);
      return null;
    }
    if (resource.provisioningState === "Creating" || resource.provisioningState === "Updating") {
      resource.provisioningState = kind === "vm" ? this.vmOutcome : "Succeeded";
      if (kind === "vm" && this.vmOutcome === "Failed") resource.failure = "Allocation failed";
      if (kind === "vm" && this.noCapacity.has(`${resource.vmSize}@${resource.zone}`)) {
        Object.assign(resource, { provisioningState: "Failed", failure: "We do not have sufficient capacity", failureCode: "ZonalAllocationFailed" });
      }
    }
    return { ...resource };
  }

  private create(kind: CloudResourceKind, extra: Partial<CloudResource> = {}): CloudResource {
    const resource: CloudResource = { provisioningState: "Creating", organization: ORG, ...extra };
    this.resources.set(kind, resource);
    return { ...resource };
  }

  async putDataDisk(target: CloudTarget, spec: { diskGiB: number; zone: string }) {
    this.check("PUT dataDisk", target);
    return this.create("dataDisk", { diskSizeGB: spec.diskGiB, zone: spec.zone });
  }

  async putNic(target: CloudTarget) {
    this.check("PUT nic", target);
    return this.create("nic");
  }

  async putVm(target: CloudTarget, spec: { size: string; zone: string; mode: "create" | "attach"; hostToken?: string; gatewayUrl?: string }) {
    this.check(`PUT vm ${spec.mode}`, target);
    this.vmPuts.push(spec);
    this.vmPlacements.push(`${spec.size}@${spec.zone}`);
    const diskZone = this.resources.get("dataDisk")?.zone;
    if (diskZone && diskZone !== spec.zone) throw new CloudError(400, "BadRequest", "the disk and the VM are in different zones");
    if (spec.mode === "create") this.resources.set("osDisk", { provisioningState: "Succeeded", organization: null });
    return this.create("vm", { vmSize: spec.size, zone: spec.zone });
  }

  async resizeVm(target: CloudTarget, size: string) {
    this.check("PATCH vm", target);
    const vm = this.resources.get("vm")!;
    Object.assign(vm, { vmSize: size, provisioningState: "Updating" });
    return { ...vm };
  }

  async growDataDisk(target: CloudTarget, diskGiB: number) {
    this.check("PATCH dataDisk", target);
    const disk = this.resources.get("dataDisk")!;
    disk.diskSizeGB = diskGiB;
    return { ...disk };
  }

  async tagOsDisk(target: CloudTarget) {
    this.check("PATCH osDisk tags", target);
    this.resources.get("osDisk")!.organization = ORG;
  }

  async claimTags(target: CloudTarget) {
    this.check("PATCH tags claim", target);
    for (const resource of this.resources.values()) resource.organization = target.organizationId;
  }

  async delete(target: CloudTarget, kind: CloudResourceKind) {
    this.check(`DELETE ${kind}`, target);
    const resource = this.resources.get(kind);
    if (!resource) return false;
    resource.provisioningState = "Deleting";
    return true;
  }
}

let cloud: FakeCloud;
let alarms: number[];
let now: number;
let connected: boolean;
let readyCalls: number;
let missingEdge: string[];
let lifecycle: ComputerLifecycle;
let deps: LifecycleDeps;
let selfManaged: boolean;
let fallbackSizes: string[];

beforeEach(() => {
  fallbackSizes = [];
  cloud = new FakeCloud();
  alarms = [];
  now = 1_000_000;
  connected = false;
  readyCalls = 0;
  missingEdge = [];
  selfManaged = false;
  deps = {
    selfManaged: () => selfManaged,
    sql: sqlStorage(),
    cloud: () => cloud,
    missingConfig: () => missingEdge,
    hostToken: async (org) => `sph_token_for_${org}`,
    gatewayUrl: (org) => `wss://edge.example/v1/computer/host?organizationId=${org}`,
    setAlarm: async (at) => void alarms.push(at),
    hostConnected: () => connected,
    zones: () => ["1", "2", "3"],
    sizes: () => fallbackSizes,
    onReady: () => void (readyCalls += 1),
    now: () => now,
    sshPublicKey: async () => "ssh-rsa AAAA test",
  };
  lifecycle = new ComputerLifecycle(deps);
});

/** Another computer, or (with `sql`) the same one after a restart. */
const another = (sql = sqlStorage()) => new ComputerLifecycle({ ...deps, sql });

const OPTIONS = { size: "Standard_D2as_v7", diskGiB: 128 };

/** Runs alarms until the state settles (or `limit` ticks). */
async function settle(limit = 20) {
  for (let i = 0; i < limit; i += 1) {
    const state = lifecycle.row()?.state;
    if (!state || !["provisioning", "waking", "parking", "deleting", "resizing"].includes(state)) return;
    now += POLL_MS;
    await lifecycle.tick();
  }
}

describe("computer lifecycle", () => {
  it("creates disk, NIC and VM in order, then is ready; the public view names no cloud", async () => {
    expect(await lifecycle.create(ORG, OPTIONS)).toEqual({ status: 202 });
    expect(lifecycle.view()).toMatchObject({ state: "provisioning", connected: false, vcpus: 2, memoryGiB: 8, diskGiB: 128, lastError: null });
    await settle();
    expect(lifecycle.row()?.state).toBe("ready");
    expect(readyCalls).toBe(1);
    expect(cloud.calls.filter((c) => c.startsWith("PUT"))).toEqual(["PUT dataDisk", "PUT nic", "PUT vm create"]);
    expect(cloud.vmPuts[0]).toMatchObject({
      hostToken: `sph_token_for_${ORG}`,
      gatewayUrl: `wss://edge.example/v1/computer/host?organizationId=${ORG}`,
    });
    // The OS disk the VM PUT created is tagged for the organization.
    expect(cloud.calls).toContain("PATCH osDisk tags");
    const view = lifecycle.view()!;
    expect(Object.keys(view).sort()).toEqual(["connected", "createdAt", "diskGiB", "lastError", "memoryGiB", "state", "updatedAt", "vcpus"]);
    expect(JSON.stringify(view)).not.toMatch(/azure|eastus|Standard_|oc-org/i);
  });

  it("is idempotent: a second create neither duplicates nor re-PUTs", async () => {
    await lifecycle.create(ORG, OPTIONS);
    expect(await lifecycle.create(ORG, OPTIONS)).toEqual({ status: 200 });
    await settle();
    expect(await lifecycle.create(ORG, OPTIONS)).toEqual({ status: 200 });
    // Provisioning again over existing resources only looks: no PUT.
    cloud.calls = [];
    deps.sql.exec("UPDATE computer SET state = 'provisioning'");
    await settle();
    expect(lifecycle.row()?.state).toBe("ready");
    expect(cloud.calls.filter((c) => c.startsWith("PUT"))).toEqual([]);
    expect(cloud.vmPuts).toHaveLength(1);
  });

  it("refuses to create without configuration, naming what is missing", async () => {
    missingEdge = ["COMPUTER_HOST_TOKEN_KEY"];
    cloud.missingNames = ["AZURE_COMPUTER_SUBNET_ID"];
    expect(await lifecycle.create(ORG, OPTIONS)).toEqual({
      status: 503,
      error: "computers are not configured: missing COMPUTER_HOST_TOKEN_KEY, AZURE_COMPUTER_SUBNET_ID",
    });
    expect(lifecycle.row()).toBeUndefined();
  });

  it("retries transient errors with backoff and fails on refusals", async () => {
    await lifecycle.create(ORG, OPTIONS);
    cloud.failNext = new CloudError(429, "TooManyRequests", "throttled");
    await lifecycle.tick();
    expect(lifecycle.row()).toMatchObject({ state: "provisioning", attempts: 1, lastError: "throttled" });
    expect(alarms.at(-1)).toBe(now + backoffMs(1));
    await settle();
    expect(lifecycle.row()?.state).toBe("ready");

    const other = another();
    await other.create(ORG, OPTIONS);
    cloud.resources.clear();
    cloud.failNext = new CloudError(400, "InvalidParameter", "bad request");
    await other.tick();
    expect(other.row()).toMatchObject({ state: "failed", lastError: "bad request" });
    expect(other.view()?.lastError).toBe("Your computer could not be started.");
  });

  it("a failed VM leaves the computer failed; creating again replaces the VM", async () => {
    cloud.vmOutcome = "Failed";
    await lifecycle.create(ORG, OPTIONS);
    await settle();
    expect(lifecycle.row()).toMatchObject({ state: "failed", lastError: "VM provisioning failed: Allocation failed" });
    expect(lifecycle.view()).toMatchObject({ state: "failed", lastError: CAPACITY_ERROR });
    cloud.vmOutcome = "Succeeded";
    expect(await lifecycle.create(ORG, OPTIONS)).toEqual({ status: 202 });
    await settle();
    expect(lifecycle.row()?.state).toBe("ready");
    expect(cloud.calls).toContain("DELETE vm");
    // The OS disk of a first boot that never reached a host is not attached: it is replaced.
    expect(cloud.calls).toContain("DELETE osDisk");
    expect(cloud.vmPuts.map((p) => p.mode)).toEqual(["create", "create"]);
  });

  it("a zone without capacity falls to the next: the empty data disk moves with the VM, and the row keeps the zone", async () => {
    cloud.noCapacity = new Set(["Standard_D2as_v7@1", "Standard_D2as_v7@2"]);
    await lifecycle.create(ORG, OPTIONS);
    await settle(60);
    expect(lifecycle.row()).toMatchObject({ state: "ready", size: "Standard_D2as_v7", zone: "3", lastError: null });
    expect(cloud.vmPlacements).toEqual(["Standard_D2as_v7@1", "Standard_D2as_v7@2", "Standard_D2as_v7@3"]);
    expect(cloud.resources.get("dataDisk")).toMatchObject({ zone: "3", provisioningState: "Succeeded" });
    // The NIC is regional: it is kept.
    expect(cloud.calls.filter((call) => call === "PUT nic")).toHaveLength(1);
    expect(cloud.calls.filter((call) => call === "DELETE dataDisk")).toHaveLength(2);

    // Parked and woken, it stays where its disk is.
    lifecycle.noteHostSeen();
    await lifecycle.park();
    await settle();
    await lifecycle.wake();
    await settle();
    expect(lifecycle.row()).toMatchObject({ state: "ready", zone: "3" });
    expect(cloud.vmPlacements.at(-1)).toBe("Standard_D2as_v7@3");
  });

  it("falls to the next size once no zone has capacity, and fails with the capacity error when nothing is left", async () => {
    fallbackSizes = ["Standard_D2s_v7"];
    cloud.noCapacity = new Set(["1", "2", "3"].map((zone) => `Standard_D2as_v7@${zone}`));
    await lifecycle.create(ORG, OPTIONS);
    await settle(80);
    expect(lifecycle.row()).toMatchObject({ state: "ready", size: "Standard_D2s_v7", zone: "1" });

    const other = another();
    cloud = new FakeCloud();
    cloud.noCapacity = new Set(["Standard_D2as_v7", "Standard_D2s_v7"].flatMap((size) => ["1", "2", "3"].map((zone) => `${size}@${zone}`)));
    await other.create(ORG, OPTIONS);
    for (let i = 0; i < 120 && other.row()?.state === "provisioning"; i += 1) await other.tick();
    expect(cloud.vmPlacements).toHaveLength(6);
    expect(other.row()).toMatchObject({ state: "failed", lastError: "VM provisioning failed: ZonalAllocationFailed: We do not have sufficient capacity" });
    expect(other.view()?.lastError).toBe(CAPACITY_ERROR);
    // Asked again, it starts over from every placement.
    cloud.noCapacity.delete("Standard_D2as_v7@2");
    await other.create(ORG, OPTIONS);
    for (let i = 0; i < 120 && other.row()?.state === "provisioning"; i += 1) await other.tick();
    expect(other.row()).toMatchObject({ state: "ready", size: "Standard_D2as_v7", zone: "2" });
  });

  it("a size family out of quota falls back like one out of capacity; another refusal of the same code does not", async () => {
    fallbackSizes = ["Standard_D2s_v7"];
    const put = cloud.putVm.bind(cloud);
    cloud.putVm = async (target, spec) => {
      if (spec.size === "Standard_D2as_v7") {
        throw new CloudError(409, "OperationNotAllowed", "Operation could not be completed as it results in exceeding approved standardDASv7Family Cores quota.");
      }
      return put(target, spec);
    };
    await lifecycle.create(ORG, OPTIONS);
    await settle(80);
    // The quota is the region's: the size's other zones are not tried, and the data disk stays.
    expect(lifecycle.row()).toMatchObject({ state: "ready", size: "Standard_D2s_v7", zone: "1" });
    expect(cloud.vmPlacements).toEqual(["Standard_D2s_v7@1"]);
    expect(cloud.calls).not.toContain("DELETE dataDisk");

    const other = another();
    cloud = new FakeCloud();
    cloud.putVm = async () => {
      throw new CloudError(409, "OperationNotAllowed", "the disk is being attached");
    };
    await other.create(ORG, OPTIONS);
    for (let i = 0; i < 6; i += 1) await other.tick();
    expect(other.row()).toMatchObject({ state: "provisioning", size: "Standard_D2as_v7", zone: "1", lastError: "the disk is being attached" });
  });

  it("remembers the size it last ran on and tries it first, so a computer that fell back does not fail first on every wake", async () => {
    fallbackSizes = ["Standard_D2s_v7"];
    await lifecycle.create(ORG, OPTIONS);
    await settle();
    expect(lifecycle.row()).toMatchObject({ state: "ready", size: "Standard_D2as_v7", preferredSize: "Standard_D2as_v7" });
    lifecycle.noteHostSeen();
    await lifecycle.park();
    await settle();

    cloud.noCapacity = new Set(["Standard_D2as_v7@1"]);
    await lifecycle.wake("Standard_D2as_v7");
    await settle(40);
    expect(lifecycle.row()).toMatchObject({ state: "ready", size: "Standard_D2s_v7", zone: "1", preferredSize: "Standard_D2s_v7" });
    expect(readAttempt(lifecycle.row()!)).toEqual({
      asked: "Standard_D2as_v7",
      candidates: [
        { size: "Standard_D2as_v7", zone: "1" },
        { size: "Standard_D2s_v7", zone: "1" },
      ],
      index: 1,
    });

    // The plan still asks for the first size; the computer goes straight to the one that worked.
    await lifecycle.park();
    await settle();
    cloud.vmPlacements = [];
    await lifecycle.wake("Standard_D2as_v7");
    await settle(40);
    expect(cloud.vmPlacements).toEqual(["Standard_D2s_v7@1"]);
    expect(lifecycle.row()).toMatchObject({ state: "ready", size: "Standard_D2s_v7" });

    // That size gone too: back to the one asked for.
    await lifecycle.park();
    await settle();
    cloud.noCapacity = new Set(["Standard_D2s_v7@1"]);
    cloud.vmPlacements = [];
    await lifecycle.wake("Standard_D2as_v7");
    await settle(40);
    expect(cloud.vmPlacements).toEqual(["Standard_D2s_v7@1", "Standard_D2as_v7@1"]);
    expect(lifecycle.row()).toMatchObject({ state: "ready", size: "Standard_D2as_v7", preferredSize: "Standard_D2as_v7" });
    expect(cloud.calls).not.toContain("DELETE dataDisk");
  });

  it("a plan of another shape overrides the remembered size, on waking and while parking", async () => {
    await lifecycle.create(ORG, { ...OPTIONS, size: "Standard_D8as_v7" });
    await settle();
    lifecycle.noteHostSeen();
    await lifecycle.park();
    await settle();
    await lifecycle.wake("Standard_D2as_v7");
    await settle();
    expect(lifecycle.row()).toMatchObject({ state: "ready", size: "Standard_D2as_v7", preferredSize: "Standard_D2as_v7" });

    await lifecycle.park();
    await lifecycle.tick();
    expect(lifecycle.row()?.state).toBe("parking");
    await lifecycle.wake("Standard_D8as_v7");
    await settle();
    expect(lifecycle.row()).toMatchObject({ state: "ready", size: "Standard_D8as_v7", preferredSize: "Standard_D8as_v7" });
  });

  it("a computer from before placements were stored keeps its size first, and one under way then fails on capacity as before", async () => {
    const sql = sqlStorage();
    sql.exec(`CREATE TABLE computer (id INTEGER PRIMARY KEY, organization_id TEXT NOT NULL, state TEXT NOT NULL, size TEXT NOT NULL,
      disk_gib INTEGER NOT NULL, zone TEXT NOT NULL, ssh_public_key TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      wake_after_park INTEGER NOT NULL DEFAULT 0, delete_disk INTEGER NOT NULL DEFAULT 0, os_initialized INTEGER NOT NULL DEFAULT 0,
      replace_failed_vm INTEGER NOT NULL DEFAULT 0, wakes INTEGER NOT NULL DEFAULT 0, resource_prefix TEXT, pool_slot TEXT,
      tags_pending INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
    sql.exec("INSERT INTO computer (id, organization_id, state, size, disk_gib, zone, ssh_public_key, created_at, updated_at) VALUES (1, ?, 'provisioning', 'Standard_D2s_v7', 128, '1', 'k', 0, 0)", ORG);
    fallbackSizes = ["Standard_D2s_v7"];
    const old = another(sql);
    expect(old.row()).toMatchObject({ preferredSize: "Standard_D2s_v7", attempt: null });
    // The backfill runs once: a later start leaves the column alone.
    sql.exec("UPDATE computer SET preferred_size = NULL");
    expect(another(sql).row()?.preferredSize).toBeNull();

    cloud.noCapacity = new Set(["Standard_D2s_v7@1"]);
    for (let i = 0; i < 20 && old.row()?.state === "provisioning"; i += 1) await old.tick();
    expect(old.row()).toMatchObject({ state: "failed", size: "Standard_D2s_v7", zone: "1" });
    expect(cloud.vmPlacements).toEqual(["Standard_D2s_v7@1"]);
  });

  it("a capacity refusal of the VM PUT itself falls back too", async () => {
    await lifecycle.create(ORG, OPTIONS);
    const put = cloud.putVm.bind(cloud);
    let refused = false;
    cloud.putVm = async (target, spec) => {
      if (!refused) {
        refused = true;
        throw new CloudError(409, "SkuNotAvailable", "the requested size is currently not available in zone 1");
      }
      return put(target, spec);
    };
    await settle(40);
    expect(lifecycle.row()).toMatchObject({ state: "ready", zone: "2" });
  });

  it("a refusal for capacity with nowhere left fails at once instead of retrying", async () => {
    let puts = 0;
    cloud.putVm = async () => {
      puts += 1;
      throw new CloudError(409, "SkuNotAvailable", "the requested size is currently not available");
    };
    await lifecycle.create(ORG, OPTIONS);
    await settle(60);
    // One PUT per zone, then failed: not ten attempts on the last.
    expect(puts).toBe(3);
    expect(lifecycle.row()).toMatchObject({ state: "failed", attempts: 0 });
    expect(lifecycle.view()?.lastError).toBe(CAPACITY_ERROR);
  });

  it("an instance view that cannot be read is asked for again: the reason decides the fallback", async () => {
    cloud.noCapacity = new Set(["Standard_D2as_v7@1"]);
    const get = cloud.get.bind(cloud);
    let throttled = 0;
    cloud.get = async (target, kind, options = {}) => {
      if (options.instanceView && throttled < 2) {
        throttled += 1;
        throw new CloudError(429, "TooManyRequests", "throttled");
      }
      return get(target, kind, options);
    };
    await lifecycle.create(ORG, OPTIONS);
    await settle(60);
    expect(throttled).toBe(2);
    expect(lifecycle.row()).toMatchObject({ state: "ready", zone: "2" });
  });

  it("a computer deleted and created again boots a new OS disk, and keeps its zone only while its data disk is kept", async () => {
    fallbackSizes = ["Standard_D2as_v7", "Standard_D2s_v7"];
    await lifecycle.create(ORG, OPTIONS);
    await settle();
    lifecycle.noteHostSeen();
    await lifecycle.delete();
    await settle();
    expect(lifecycle.row()).toMatchObject({ state: "deleted", dataUsed: 1 });

    // The data disk was kept: no other zone, and the OS disk a failed first try leaves is not attached.
    cloud.noCapacity = new Set(["Standard_D2as_v7@1"]);
    cloud.vmPuts = [];
    await lifecycle.create(ORG, OPTIONS);
    await settle(60);
    expect(lifecycle.row()).toMatchObject({ state: "ready", size: "Standard_D2s_v7", zone: "1" });
    expect(cloud.vmPuts.map((put) => put.mode)).toEqual(["create", "create"]);
    expect(cloud.vmPuts.at(-1)?.hostToken).toBe(`sph_token_for_${ORG}`);
    expect(cloud.calls).not.toContain("DELETE dataDisk");

    // Deleted with its data: created again, it may go to another zone.
    lifecycle.noteHostSeen();
    await lifecycle.delete({ deleteDisk: true });
    await settle();
    expect(lifecycle.row()).toMatchObject({ state: "deleted", dataUsed: 0 });
    cloud.noCapacity = new Set(["Standard_D2as_v7@1", "Standard_D2s_v7@1"]);
    await lifecycle.create(ORG, OPTIONS);
    await settle(60);
    expect(lifecycle.row()).toMatchObject({ state: "ready", zone: "2" });
  });

  it("a size taken out of the settings is no longer tried first", async () => {
    fallbackSizes = ["Standard_D2as_v7", "Standard_D2s_v7"];
    cloud.noCapacity = new Set(["1", "2", "3"].map((zone) => `Standard_D2as_v7@${zone}`));
    await lifecycle.create(ORG, OPTIONS);
    await settle(80);
    lifecycle.noteHostSeen();
    expect(lifecycle.row()).toMatchObject({ state: "ready", preferredSize: "Standard_D2s_v7" });
    await lifecycle.park();
    await settle();
    fallbackSizes = ["Standard_D2as_v7"];
    cloud.noCapacity = new Set();
    cloud.vmPlacements = [];
    await lifecycle.wake("Standard_D2as_v7");
    await settle();
    expect(cloud.vmPlacements).toEqual(["Standard_D2as_v7@1"]);
  });

  it("a wake keeps its zone: with no capacity there it changes size, or fails saying so, and never touches the data disk", async () => {
    await lifecycle.create(ORG, OPTIONS);
    await settle();
    lifecycle.noteHostSeen();
    await lifecycle.park();
    await settle();
    cloud.noCapacity = new Set(["Standard_D2as_v7@1"]);
    await lifecycle.wake();
    await settle(40);
    expect(lifecycle.row()).toMatchObject({ state: "failed", zone: "1" });
    expect(lifecycle.view()?.lastError).toBe(CAPACITY_ERROR);

    fallbackSizes = ["Standard_D2s_v7"];
    await lifecycle.create(ORG, OPTIONS);
    await settle(40);
    expect(lifecycle.row()).toMatchObject({ state: "ready", size: "Standard_D2s_v7", zone: "1" });
    expect(cloud.vmPlacements.slice(-2)).toEqual(["Standard_D2as_v7@1", "Standard_D2s_v7@1"]);
    expect(cloud.vmPuts.at(-1)).toMatchObject({ mode: "attach", size: "Standard_D2s_v7" });
    expect(cloud.calls).not.toContain("DELETE dataDisk");
    expect(cloud.calls.filter((call) => call === "PUT dataDisk")).toHaveLength(1);
  });

  it("a delete keeps retrying transient errors instead of stopping half way", async () => {
    await lifecycle.create(ORG, OPTIONS);
    await settle();
    await lifecycle.delete({ deleteDisk: true });
    for (let i = 0; i < 15; i += 1) {
      cloud.failNext = new CloudError(409, "OperationNotAllowed", "the disk is being attached");
      await lifecycle.tick();
    }
    expect(lifecycle.row()).toMatchObject({ state: "deleting", attempts: 15 });
    expect(alarms.at(-1)).toBe(now + backoffMs(15));
    await settle();
    expect(lifecycle.row()?.state).toBe("deleted");
    expect(cloud.resources.size).toBe(0);
  });

  it("refuses resources tagged for another organization", async () => {
    cloud.resources.set("dataDisk", { provisioningState: "Succeeded", organization: "org_other" });
    await lifecycle.create(ORG, OPTIONS);
    await lifecycle.tick();
    expect(lifecycle.row()).toMatchObject({ state: "failed", lastError: "data disk is tagged for org_other, not org_test" });
    expect(cloud.calls.filter((c) => c.startsWith("PUT"))).toEqual([]);
  });

  it("parks by deleting VM and NIC only, and wakes by attaching the kept OS disk", async () => {
    await lifecycle.create(ORG, OPTIONS);
    await settle();
    lifecycle.noteHostSeen();
    expect(await lifecycle.park()).toBe(true);
    expect(lifecycle.view()?.state).toBe("parked");
    await settle();
    expect(lifecycle.row()?.state).toBe("parked");
    expect([...cloud.resources.keys()].sort()).toEqual(["dataDisk", "osDisk"]);
    expect(cloud.calls.filter((c) => c.startsWith("DELETE"))).toEqual(["DELETE vm", "DELETE nic"]);

    cloud.calls = [];
    expect(await lifecycle.create(ORG, OPTIONS)).toEqual({ status: 202 });
    expect(lifecycle.view()?.state).toBe("waking");
    await settle();
    expect(lifecycle.row()).toMatchObject({ state: "ready", wakes: 1 });
    expect(cloud.calls.filter((c) => c.startsWith("PUT"))).toEqual(["PUT nic", "PUT vm attach"]);
    expect(cloud.vmPuts.at(-1)).not.toHaveProperty("hostToken");
    expect(readyCalls).toBe(2);
  });

  it("a wake asked for while parking happens once parked", async () => {
    await lifecycle.create(ORG, OPTIONS);
    await settle();
    lifecycle.noteHostSeen();
    await lifecycle.park();
    await lifecycle.tick();
    expect(await lifecycle.wake()).toBe(true);
    await settle();
    expect(lifecycle.row()?.state).toBe("ready");
    expect(cloud.vmPuts.at(-1)?.mode).toBe("attach");
  });

  it("only a ready computer parks", async () => {
    expect(await lifecycle.park()).toBe(false);
    await lifecycle.create(ORG, OPTIONS);
    expect(await lifecycle.park()).toBe(false);
  });

  it("resizes within the disk controller family and grows but never shrinks the disk", async () => {
    await lifecycle.create(ORG, OPTIONS);
    await settle();
    expect(await lifecycle.resize("Standard_D4ds_v5")).toMatchObject({ status: 400 });
    expect(await lifecycle.resize("Standard_D4as_v7")).toEqual({ status: 202 });
    expect(lifecycle.view()?.state).toBe("ready");
    await settle();
    expect(lifecycle.row()).toMatchObject({ state: "ready", size: "Standard_D4as_v7" });
    expect(lifecycle.view()).toMatchObject({ vcpus: 4, memoryGiB: 16 });
    expect(await lifecycle.growDisk(64)).toMatchObject({ status: 400, error: expect.stringMatching(/cannot shrink/) });
    expect(await lifecycle.growDisk(256)).toEqual({ status: 200 });
    expect(lifecycle.view()?.diskGiB).toBe(256);
  });

  it("stores the resource name prefix and names every cloud call by it", async () => {
    await lifecycle.create(ORG, OPTIONS);
    expect(lifecycle.row()?.resourcePrefix).toBe("oc-org-test");
    // A computer that changed hands keeps the name it was built under.
    deps.sql.exec("UPDATE computer SET resource_prefix = 'oc-pool-abc123'");
    await settle();
    lifecycle.noteHostSeen();
    await lifecycle.park();
    await settle();
    await lifecycle.wake();
    await settle();
    expect(await lifecycle.resize("Standard_D4as_v7")).toEqual({ status: 202 });
    await settle();
    expect(await lifecycle.growDisk(256)).toEqual({ status: 200 });
    expect(cloud.calls).toEqual(expect.arrayContaining(["DELETE vm", "PUT vm attach", "PATCH vm", "PATCH dataDisk"]));
    expect(new Set(cloud.prefixes)).toEqual(new Set(["oc-pool-abc123"]));
  });

  it("falls back to the name derived from the organization on rows from before the prefix was stored", async () => {
    await lifecycle.create(ORG, OPTIONS);
    deps.sql.exec("UPDATE computer SET resource_prefix = NULL");
    await settle();
    expect(lifecycle.row()).toMatchObject({ state: "ready", resourcePrefix: null });
    expect(new Set(cloud.prefixes)).toEqual(new Set(["oc-org-test"]));
  });

  it("adds the prefix column to a table from before it existed", () => {
    const sql = sqlStorage();
    sql.exec(`CREATE TABLE computer (id INTEGER PRIMARY KEY, organization_id TEXT NOT NULL, state TEXT NOT NULL, size TEXT NOT NULL,
      disk_gib INTEGER NOT NULL, zone TEXT NOT NULL, ssh_public_key TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      wake_after_park INTEGER NOT NULL DEFAULT 0, delete_disk INTEGER NOT NULL DEFAULT 0, os_initialized INTEGER NOT NULL DEFAULT 0,
      replace_failed_vm INTEGER NOT NULL DEFAULT 0, wakes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
    sql.exec("INSERT INTO computer (id, organization_id, state, size, disk_gib, zone, ssh_public_key, created_at, updated_at) VALUES (1, ?, 'ready', 'Standard_D2as_v7', 128, '1', 'k', 0, 0)", ORG);
    const old = another(sql);
    expect(old.target(old.row()!)).toEqual({ organizationId: ORG, prefix: "oc-org-test" });
  });

  it("deletes VM, NIC and OS disk, keeping the data disk unless asked", async () => {
    await lifecycle.create(ORG, OPTIONS);
    await settle();
    await lifecycle.delete();
    expect(lifecycle.view()?.state).toBe("deleting");
    await settle();
    expect(lifecycle.row()?.state).toBe("deleted");
    expect(lifecycle.view()).toBeNull();
    expect([...cloud.resources.keys()]).toEqual(["dataDisk"]);
  });

  it("hands a ready pool computer over once, and leaves it alone afterwards", async () => {
    const pool = another();
    expect(pool.transfer()).toBeNull();
    await pool.create("pool-abc123", OPTIONS);
    expect(pool.row()?.resourcePrefix).toBe("oc-pool-abc123");
    for (const resource of ["dataDisk", "nic"] as const) cloud.resources.set(resource, { provisioningState: "Succeeded", organization: "pool" });
    while (pool.row()?.state === "provisioning") {
      // FakeCloud tags what it creates for ORG; a pool computer's resources say `pool`.
      for (const resource of cloud.resources.values()) resource.organization = "pool";
      await pool.tick();
    }
    expect(pool.row()?.state).toBe("ready");
    expect(pool.transfer()).toEqual({
      prefix: "oc-pool-abc123",
      size: "Standard_D2as_v7",
      diskGiB: 128,
      zone: "1",
      sshPublicKey: "ssh-rsa AAAA test",
      poolSlot: "pool-abc123",
    });
    expect(pool.row()?.state).toBe("transferred");
    expect(pool.view()).toBeNull();
    expect(pool.transfer()).toBeNull();
    expect(await pool.park()).toBe(false);
    expect(await pool.delete({ deleteDisk: true })).toMatchObject({ status: 404 });
    expect(await pool.create("pool-abc123", OPTIONS)).toMatchObject({ status: 409 });
    const calls = cloud.calls.length;
    await pool.tick();
    expect(cloud.calls.length).toBe(calls);
  });

  it("adopts a claimed computer ready on its prefix, moves the tags on the alarm, then enforces them", async () => {
    for (const kind of ["vm", "nic", "dataDisk", "osDisk"] as const) cloud.resources.set(kind, { provisioningState: "Succeeded", organization: "pool" });
    const adopted = { prefix: "oc-pool-abc123", size: "Standard_D2as_v7", diskGiB: 128, zone: "1", sshPublicKey: "k", poolSlot: "pool-abc123" };
    expect(await lifecycle.adopt(ORG, adopted)).toBe(true);
    expect(await lifecycle.adopt(ORG, adopted)).toBe(false);
    expect(lifecycle.row()).toMatchObject({ state: "ready", osInitialized: 1, tagsPending: 1, resourcePrefix: "oc-pool-abc123", poolSlot: "pool-abc123" });
    expect(lifecycle.view()).toMatchObject({ state: "ready", connected: false, vcpus: 2, diskGiB: 128 });
    expect(readyCalls).toBe(1);
    expect(alarms.at(-1)).toBe(now);
    // The tags move on the alarm; a transient failure retries with backoff.
    cloud.failNext = new CloudError(503, "ServiceUnavailable", "busy");
    await lifecycle.tick();
    expect(lifecycle.row()).toMatchObject({ state: "ready", tagsPending: 1, attempts: 1 });
    expect(alarms.at(-1)).toBe(now + backoffMs(1));
    await lifecycle.tick();
    expect(lifecycle.row()).toMatchObject({ state: "ready", tagsPending: 0, attempts: 0 });
    expect(cloud.calls.filter((c) => c === "PATCH tags claim")).toHaveLength(2);
    expect([...cloud.resources.values()].every((r) => r.organization === ORG)).toBe(true);
    // Parked and woken on the pool computer's names.
    await lifecycle.park();
    await settle();
    await lifecycle.wake();
    await settle();
    expect(lifecycle.row()?.state).toBe("ready");
    expect(new Set(cloud.prefixes)).toEqual(new Set(["oc-pool-abc123"]));
    // With the tags moved, a resource still saying `pool` is refused again.
    cloud.resources.get("vm")!.organization = "pool";
    expect(await lifecycle.park()).toBe(true);
    await lifecycle.tick();
    expect(lifecycle.row()).toMatchObject({ state: "failed", lastError: "vm is tagged for pool, not org_test" });
  });

  it("parks a claimed computer whose tags have not moved yet", async () => {
    for (const kind of ["vm", "nic", "dataDisk", "osDisk"] as const) cloud.resources.set(kind, { provisioningState: "Succeeded", organization: "pool" });
    await lifecycle.adopt(ORG, { prefix: "oc-pool-abc123", size: "Standard_D2as_v7", diskGiB: 128, zone: "1", sshPublicKey: "k", poolSlot: "pool-abc123" });
    cloud.failNext = new CloudError(409, "not_claimable", "vm is tagged for org_other, not the pool");
    await lifecycle.tick();
    // A refusal is not retried and does not fail the computer.
    expect(lifecycle.row()).toMatchObject({ state: "ready", tagsPending: 1, attempts: 0 });
    expect(await lifecycle.park()).toBe(true);
    await settle();
    expect(lifecycle.row()?.state).toBe("parked");
  });
});

// Work 105: the operator runs the VM; the lifecycle never calls the cloud.
describe("self-managed VMs", () => {
  beforeEach(() => {
    selfManaged = true;
  });

  it("is ready at once without a cloud call or an alarm, and is offline until its host connects", async () => {
    expect(await lifecycle.create(ORG, OPTIONS)).toEqual({ status: 200 });
    expect(lifecycle.view()).toMatchObject({ state: "ready", connected: false, lastError: null });
    expect(readyCalls).toBe(1);
    connected = true;
    expect(lifecycle.view()).toMatchObject({ state: "ready", connected: true });
    // Idempotent: a second create changes nothing.
    expect(await lifecycle.create(ORG, OPTIONS)).toEqual({ status: 200 });
    expect(readyCalls).toBe(1);
    expect(cloud.calls).toEqual([]);
    expect(alarms).toEqual([]);
  });

  it("needs no platform, only the edge's own settings", async () => {
    cloud.missingNames = ["AZURE_SUBSCRIPTION_ID"];
    expect(await lifecycle.missingConfig()).toEqual([]);
    missingEdge = ["COMPUTER_HOST_TOKEN_KEY"];
    expect(await lifecycle.create(ORG, OPTIONS)).toMatchObject({ status: 503 });
    expect(lifecycle.row()).toBeUndefined();
  });

  it("never parks, wakes, resizes or grows a disk", async () => {
    await lifecycle.create(ORG, OPTIONS);
    expect(await lifecycle.park()).toBe(false);
    expect(await lifecycle.wake()).toBe(false);
    expect(await lifecycle.resize("Standard_D8as_v7")).toMatchObject({ status: 409 });
    expect(await lifecycle.growDisk(256)).toMatchObject({ status: 409 });
    await lifecycle.tick();
    expect(lifecycle.row()).toMatchObject({ state: "ready", size: OPTIONS.size, diskGiB: 128 });
    expect(cloud.calls).toEqual([]);
    expect(alarms).toEqual([]);
  });

  it("forgets the computer on delete and leaves the VM alone; create brings it back", async () => {
    await lifecycle.create(ORG, OPTIONS);
    expect(await lifecycle.delete({ deleteDisk: true })).toEqual({ status: 200 });
    expect(lifecycle.view()).toBeNull();
    expect(await lifecycle.create(ORG, OPTIONS)).toEqual({ status: 200 });
    expect(lifecycle.row()?.state).toBe("ready");
    expect(cloud.calls).toEqual([]);
  });

  it("takes over a row the gateway managed before: parked or failed becomes ready, with no step left to run", async () => {
    selfManaged = false;
    await lifecycle.create(ORG, OPTIONS);
    await settle();
    await lifecycle.park();
    await settle();
    expect(lifecycle.row()?.state).toBe("parked");
    selfManaged = true;
    cloud.calls = [];
    alarms = [];
    expect(await lifecycle.create(ORG, OPTIONS)).toEqual({ status: 200 });
    expect(lifecycle.row()?.state).toBe("ready");
    expect(cloud.calls).toEqual([]);
    expect(alarms).toEqual([]);
  });

  it("still refuses another organization's computer", async () => {
    await lifecycle.create(ORG, OPTIONS);
    expect(await lifecycle.create("org_other", OPTIONS)).toMatchObject({ status: 409 });
  });
});
