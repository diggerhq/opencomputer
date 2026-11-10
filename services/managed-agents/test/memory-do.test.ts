import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemoryDurableObject } from "../src/edge/memory-do.js";
import type {
  Document,
  MemoryBinding,
  MemoryWriter,
  ResourceConfig,
} from "../src/edge/memory-contract.js";
import { memoryObjectName } from "../src/edge/memory-contract.js";

/**
 * Drives the Memory Durable Object directly over RPC. Evictions are real:
 * the object is dropped and the next call constructs a fresh activation over
 * the same SQLite storage, so everything asserted after `evict()` is what
 * durably survived.
 */

let counter = 0;

function memory(): DurableObjectStub<MemoryDurableObject> {
  return env.MEMORY.getByName(memoryObjectName("acct", `prj_${String(++counter)}`, "development"));
}

const owner = { kind: "owner" } as const;
const notes: ResourceConfig = { resource: "notes", provider: "document", maxBytes: 8_192 };

async function configured(
  resources: ResourceConfig[] = [notes],
): Promise<DurableObjectStub<MemoryDurableObject>> {
  const stub = memory();
  expect(await stub.applyConfig(1, "dep-1", resources)).toMatchObject({ kind: "applied", seq: 1 });
  return stub;
}

async function created(
  stub: DurableObjectStub<MemoryDurableObject>,
  id: string,
  input: { title?: string; text?: string; summary?: string; agentWrites?: "enabled" | "disabled" } = {},
): Promise<Document> {
  const outcome = await stub.createDocument(
    "notes",
    id,
    { title: input.title ?? `Title ${id}`, text: input.text ?? "", ...input },
    owner,
  );
  if (outcome.kind !== "created") throw new Error(`create ${id}: ${JSON.stringify(outcome)}`);
  return outcome.document;
}

async function evict(stub: DurableObjectStub<MemoryDurableObject>): Promise<void> {
  await runInDurableObject(stub, () => undefined);
  await evictDurableObject(stub);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-10T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("documents", () => {
  it("creates with owner stamping, reads back and reports the resource limit", async () => {
    const stub = await configured([{ ...notes, maxBytes: 4_096 }]);
    const document = await created(stub, "workshop", {
      title: "Workshop requirements",
      text: "Node.js 22, no paid services.",
      summary: "Runtime requirements.",
    });
    expect(document).toMatchObject({
      id: "workshop",
      title: "Workshop requirements",
      text: "Node.js 22, no paid services.",
      summary: "Runtime requirements.",
      agentWrites: "enabled",
      revision: "1",
      bytes: 29,
      maxBytes: 4_096,
      updatedAt: "2026-09-10T12:00:00.000Z",
      writer: { kind: "owner" },
    });
    expect(await stub.getDocument("notes", "workshop")).toEqual({ kind: "document", document });
    expect(await stub.getDocument("notes", "absent")).toEqual({ kind: "missing" });
  });

  it("replace and patch are compare-and-set; a conflict carries the current document", async () => {
    const stub = await configured();
    const first = await created(stub, "workshop", { text: "v1" });
    const written = await stub.replaceDocument("notes", "workshop", { text: "v2" }, first.revision, owner);
    expect(written).toMatchObject({ kind: "written", document: { text: "v2", revision: "2", bytes: 2 } });

    const stale = await stub.replaceDocument("notes", "workshop", { text: "v3" }, first.revision, owner);
    expect(stale).toMatchObject({ kind: "conflict", current: { text: "v2", revision: "2" } });
    expect(await stub.patchDocument("notes", "workshop", { agentWrites: "disabled" }, "1", owner)).toMatchObject({
      kind: "conflict",
      current: { revision: "2", agentWrites: "enabled" },
    });

    const patched = await stub.patchDocument(
      "notes",
      "workshop",
      { title: "Renamed", agentWrites: "disabled" },
      "2",
      { kind: "agent", sessionId: "s-1" },
    );
    expect(patched).toMatchObject({
      kind: "written",
      document: { title: "Renamed", agentWrites: "disabled", text: "v2", revision: "3", writer: { kind: "agent", sessionId: "s-1" } },
    });
    expect(await stub.replaceDocument("notes", "workshop", { text: "x" }, "not-a-revision", owner)).toMatchObject({ kind: "conflict" });
  });

  it("an omitted summary is preserved and an empty one clears it", async () => {
    const stub = await configured();
    const first = await created(stub, "workshop", { text: "v1", summary: "keep me" });
    const kept = await stub.replaceDocument("notes", "workshop", { text: "v2" }, first.revision, owner);
    expect(kept).toMatchObject({ kind: "written", document: { summary: "keep me" } });
    const cleared = await stub.replaceDocument(
      "notes",
      "workshop",
      { text: "v3", summary: "" },
      (kept as { document: Document }).document.revision,
      owner,
    );
    expect(cleared).toMatchObject({ kind: "written", document: { summary: "" } });
  });

  it("a deleted id stays reserved: create after delete conflicts, reads say deleted", async () => {
    const stub = await configured();
    const document = await created(stub, "workshop", { text: "gone soon" });
    expect(await stub.deleteDocument("notes", "workshop", "0", owner)).toMatchObject({ kind: "conflict" });
    expect(await stub.deleteDocument("notes", "workshop", document.revision, owner)).toEqual({ kind: "deleted" });
    await evict(stub);
    expect(await stub.getDocument("notes", "workshop")).toEqual({ kind: "deleted" });
    expect(await stub.createDocument("notes", "workshop", { title: "Again" }, owner)).toEqual({ kind: "conflict", reason: "deleted" });
    expect(await stub.createDocument("notes", "other", { title: "Other" }, owner)).toMatchObject({ kind: "created" });
    expect(await stub.createDocument("notes", "other", { title: "Other" }, owner)).toEqual({ kind: "conflict", reason: "exists" });
    expect(await stub.replaceDocument("notes", "workshop", { text: "x" }, "2", owner)).toEqual({ kind: "rejected", reason: "not_found" });
    expect(await stub.deleteDocument("notes", "workshop", "2", owner)).toEqual({ kind: "rejected", reason: "not_found" });
    expect((await stub.listDocuments("notes")).documents.map((entry) => entry.id)).toEqual(["other"]);
  });

  it("enforces title and summary byte limits", async () => {
    const stub = await configured();
    expect(await stub.createDocument("notes", "a", { title: "" }, owner)).toMatchObject({
      kind: "rejected",
      reason: "too_large",
      field: "title",
    });
    expect(await stub.createDocument("notes", "a", { title: "é".repeat(121) }, owner)).toMatchObject({
      kind: "rejected",
      reason: "too_large",
      bytes: 242,
      maxBytes: 240,
      field: "title",
    });
    expect(await stub.createDocument("notes", "a", { title: "ok", summary: "x".repeat(241) }, owner)).toMatchObject({
      kind: "rejected",
      reason: "too_large",
      bytes: 241,
      maxBytes: 240,
      field: "summary",
    });
    const document = await created(stub, "a");
    expect(await stub.patchDocument("notes", "a", { title: "x".repeat(241) }, document.revision, owner)).toMatchObject({
      kind: "rejected",
      reason: "too_large",
      field: "title",
    });
  });
});

describe("configuration activation", () => {
  it("applies in seq order: A, B, then A again with a higher seq; a stale seq is a no-op", async () => {
    const stub = memory();
    const a: ResourceConfig[] = [{ resource: "notes", provider: "document", maxBytes: 8_192 }];
    const b: ResourceConfig[] = [{ resource: "notes", provider: "document", maxBytes: 4_096 }];
    expect(await stub.applyConfig(1, "dep-a", a)).toEqual({ kind: "applied", seq: 1, current: a });
    expect(await stub.applyConfig(2, "dep-b", b)).toEqual({ kind: "applied", seq: 2, current: b });
    // A delayed retry of the older promotion cannot overwrite the newer one.
    expect(await stub.applyConfig(1, "dep-a", a)).toEqual({ kind: "stale", seq: 2, current: b });
    expect(await stub.applyConfig(2, "dep-b", b)).toEqual({ kind: "stale", seq: 2, current: b });
    await evict(stub);
    // Rollback to A is a new activation with a fresh seq, never a duplicate.
    expect(await stub.applyConfig(3, "dep-a", a)).toEqual({ kind: "applied", seq: 3, current: a });
    expect(await stub.applyConfig(2, "dep-b", b)).toEqual({ kind: "stale", seq: 3, current: a });
  });

  it("rejects a provider kind change and keeps removed resources", async () => {
    const stub = await configured([notes, { resource: "facts", provider: "http", maxBytes: 1_024 }]);
    expect(
      await stub.applyConfig(2, "dep-2", [{ resource: "facts", provider: "document", maxBytes: 1_024 }]),
    ).toEqual({ kind: "rejected", reason: "provider_kind", resource: "facts" });
    // Nothing from the rejected activation was applied.
    expect(await stub.applyConfig(2, "dep-2", [notes])).toMatchObject({
      kind: "applied",
      seq: 2,
      current: [
        { resource: "facts", provider: "http", maxBytes: 1_024 },
        notes,
      ],
    });
  });

  it("limits are forward: an oversized document stays readable and must fit on its next save", async () => {
    const stub = await configured();
    const big = "x".repeat(6_000);
    const document = await created(stub, "workshop", { text: big });
    expect(await stub.applyConfig(2, "dep-2", [{ ...notes, maxBytes: 4_096 }])).toMatchObject({ kind: "applied" });
    await evict(stub);
    const read = await stub.getDocument("notes", "workshop");
    expect(read).toMatchObject({ kind: "document", document: { text: big, bytes: 6_000, maxBytes: 4_096 } });
    expect(await stub.replaceDocument("notes", "workshop", { text: "y".repeat(5_000) }, document.revision, owner)).toEqual({
      kind: "rejected",
      reason: "too_large",
      bytes: 5_000,
      maxBytes: 4_096,
      field: "text",
    });
    expect(await stub.replaceDocument("notes", "workshop", { text: "y".repeat(4_096) }, document.revision, owner)).toMatchObject({
      kind: "written",
      document: { bytes: 4_096 },
    });
    expect(await stub.createDocument("notes", "large", { title: "t", text: "z".repeat(4_097) }, owner)).toMatchObject({
      kind: "rejected",
      reason: "too_large",
    });
  });

  it("uses the 8 KiB default when no configuration has been applied", async () => {
    const stub = memory();
    expect(await stub.createDocument("notes", "a", { title: "t", text: "x".repeat(8_192) }, owner)).toMatchObject({
      kind: "created",
      document: { maxBytes: 8_192 },
    });
    expect(await stub.createDocument("notes", "b", { title: "t", text: "x".repeat(8_193) }, owner)).toMatchObject({
      kind: "rejected",
      reason: "too_large",
      maxBytes: 8_192,
    });
  });
});

describe("collections", () => {
  it("lists newest first with the id as tie-breaker, in pages of 50 with an opaque cursor", async () => {
    const stub = await configured();
    for (let index = 0; index < 120; index += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 1 + Math.floor(index / 10), 12)));
      await created(stub, `doc-${String(index).padStart(3, "0")}`);
    }
    const first = await stub.listDocuments("notes");
    expect(first.documents).toHaveLength(50);
    expect(first.documents[0]).toMatchObject({ id: "doc-110", updatedAt: "2026-09-12T12:00:00.000Z" });
    expect(first.documents[9]?.id).toBe("doc-119");
    expect(first.documents[10]?.id).toBe("doc-100");
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await stub.listDocuments("notes", { cursor: first.nextCursor! });
    expect(second.documents[0]?.id).toBe("doc-060");
    expect(second.documents).toHaveLength(50);
    const third = await stub.listDocuments("notes", { cursor: second.nextCursor! });
    expect(third.documents).toHaveLength(20);
    expect(third.documents.at(-1)?.id).toBe("doc-009");
    expect(third.nextCursor).toBeNull();
    const ids = [...first.documents, ...second.documents, ...third.documents].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(120);
    expect(first.documents[0]).not.toHaveProperty("text");
    expect((await stub.listDocuments("notes", { limit: 5 })).documents).toHaveLength(5);
  });

  it("recall projects the fixed overview lines and only whole entries within 16 KiB", async () => {
    const stub = await configured();
    vi.setSystemTime(new Date("2026-09-09T08:00:00.000Z"));
    await created(stub, "budget", { title: "Conference budget", summary: "Q4 figures in EUR, hotel refund excluded." });
    vi.setSystemTime(new Date("2026-09-10T12:00:00.000Z"));
    await created(stub, "workshop", { title: "Workshop requirements", summary: "Node.js 22, no paid services." });
    await created(stub, "multi", { title: "Line\nbreak", summary: "" });
    const bindings: MemoryBinding[] = [{ resource: "notes", scope: "collection", access: "read" }];
    expect(await stub.issueGrants("s-1", bindings)).toEqual({ kind: "issued", bindings });
    const recalled = await stub.recall("s-1", "notes");
    expect(recalled).toMatchObject({
      kind: "projection",
      projection: {
        text: [
          "multi | Line break |  | 2026-09-10",
          "workshop | Workshop requirements | Node.js 22, no paid services. | 2026-09-10",
          "budget | Conference budget | Q4 figures in EUR, hotel refund excluded. | 2026-09-09",
        ].join("\n"),
        writable: false,
      },
    });
    const projection = (recalled as { projection: { sources: unknown[]; cursor: string } }).projection;
    expect(projection.sources).toEqual([
      { id: "multi", title: "Line\nbreak", revision: "1", updatedAt: "2026-09-10T12:00:00.000Z" },
      { id: "workshop", title: "Workshop requirements", revision: "1", updatedAt: "2026-09-10T12:00:00.000Z" },
      { id: "budget", title: "Conference budget", revision: "1", updatedAt: "2026-09-09T08:00:00.000Z" },
    ]);
    // The overview cursor continues where the overview stopped.
    expect(await stub.listCollection("s-1", "notes", projection.cursor)).toEqual({ documents: [], nextCursor: null });

    // Sixty documents with 240-byte summaries: 50 fit by count, then the byte
    // budget stops the overview at whole entries.
    const wide = memory();
    await wide.applyConfig(1, "dep", [notes]);
    for (let index = 0; index < 60; index += 1) {
      await wide.createDocument(
        "notes",
        `d${String(index).padStart(2, "0")}`,
        { title: "T".repeat(240), summary: "S".repeat(240) },
        owner,
      );
    }
    await wide.issueGrants("s-2", bindings);
    const overview = await wide.recall("s-2", "notes");
    const text = (overview as { projection: { text: string; sources: unknown[] } }).projection.text;
    const lines = text.split("\n");
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(16_384);
    expect(lines.length).toBeLessThan(50);
    expect(lines.length).toBe((overview as { projection: { sources: unknown[] } }).projection.sources.length);
    expect(lines.every((line) => /^d\d\d \| T+ \| S+ \| \d{4}-\d\d-\d\d$/.test(line))).toBe(true);
    // And the remaining documents are reachable through the list cursor.
    const rest = await wide.listCollection(
      "s-2",
      "notes",
      (overview as { projection: { cursor: string } }).projection.cursor,
    );
    expect("documents" in rest && rest.documents.length).toBe(Math.min(50, 60 - lines.length));
  });
});

describe("grants and session closure", () => {
  const rw: MemoryBinding[] = [{ resource: "notes", scope: "document", id: "workshop", access: "read-write" }];

  it("issues a binding set once, returns it on an identical retry and conflicts on a different one", async () => {
    const stub = await configured();
    await created(stub, "workshop", { text: "v1" });
    await created(stub, "other");
    expect(await stub.issueGrants("s-1", rw)).toEqual({ kind: "issued", bindings: rw });
    await evict(stub);
    expect(await stub.issueGrants("s-1", rw)).toEqual({ kind: "issued", bindings: rw });
    expect(
      await stub.issueGrants("s-1", [{ resource: "notes", scope: "document", id: "workshop", access: "read" }]),
    ).toEqual({ kind: "conflict", bindings: rw });
    expect(
      await stub.issueGrants("s-1", [...rw, { resource: "other", scope: "collection", access: "read" }]),
    ).toEqual({ kind: "conflict", bindings: rw });
  });

  it("rejects undeclared resources and missing documents", async () => {
    const stub = await configured();
    await created(stub, "workshop");
    expect(await stub.issueGrants("s-1", [{ resource: "nope", scope: "collection", access: "read" }])).toEqual({
      kind: "rejected",
      reason: "undeclared",
      resource: "nope",
    });
    expect(
      await stub.issueGrants("s-1", [{ resource: "notes", scope: "document", id: "absent", access: "read" }]),
    ).toEqual({ kind: "rejected", reason: "not_found", resource: "notes", id: "absent" });
    // A rejected set left no partial grants behind.
    expect(await stub.recall("s-1", "notes")).toEqual({ kind: "rejected", reason: "not_bound" });
  });

  it("closes permanently: issue after close is rejected, saves before close stand, after close fail", async () => {
    const stub = await configured();
    const document = await created(stub, "workshop", { text: "v1" });
    expect(await stub.closeSession("never-issued")).toEqual({ closed: true });
    expect(await stub.issueGrants("never-issued", rw)).toEqual({ kind: "closed" });

    expect(await stub.issueGrants("s-1", rw)).toMatchObject({ kind: "issued" });
    const saved = await stub.save("s-1", "notes", { text: "v2" }, document.revision);
    expect(saved).toEqual({ status: "saved", revision: "2", bytes: 2 });
    expect(await stub.closeSession("s-1")).toEqual({ closed: true });
    await evict(stub);
    expect(await stub.closeSession("s-1")).toEqual({ closed: true });
    expect(await stub.save("s-1", "notes", { text: "v3" }, "2")).toEqual({
      status: "rejected",
      reason: "session_closed",
    });
    expect(await stub.recall("s-1", "notes")).toEqual({ kind: "rejected", reason: "session_closed" });
    expect(await stub.getDocument("notes", "workshop")).toMatchObject({
      kind: "document",
      document: { text: "v2", writer: { kind: "agent", sessionId: "s-1" } },
    });
  });
});

describe("owner writer stamping", () => {
  it("owner operations take only a platform-stamped writer", async () => {
    const stub = await configured();
    const bad = { kind: "agent" } as unknown as MemoryWriter;
    const document = await created(stub, "w");
    // A programming error, asserted in the object: a rejection that crosses
    // the test pool's RPC boundary is also reported as unhandled there.
    await runInDurableObject(stub, async (instance: MemoryDurableObject) => {
      await expect(instance.createDocument("notes", "w2", { title: "t" }, bad)).rejects.toThrow("Memory writer");
      await expect(instance.replaceDocument("notes", "w", { text: "x" }, document.revision, bad)).rejects.toThrow("Memory writer");
      await expect(instance.patchDocument("notes", "w", { title: "y" }, document.revision, bad)).rejects.toThrow("Memory writer");
      await expect(instance.deleteDocument("notes", "w", document.revision, bad)).rejects.toThrow("Memory writer");
    });
    expect(await stub.getDocument("notes", "w")).toMatchObject({ kind: "document", document: { title: "Title w", revision: "1" } });
    expect(await stub.getDocument("notes", "w2")).toMatchObject({ kind: "missing" });
  });

  it("the object name refuses the project placeholder of an agent outside any project", () => {
    expect(() => memoryObjectName("acct", "project:agent", "development")).toThrow("Memory needs a project");
    expect(() => memoryObjectName("acct", "", "development")).toThrow("Memory needs a project");
    expect(memoryObjectName("acct", "proj_1", "production")).toBe("acct:proj_1:production");
  });
});

describe("executing session", () => {
  it("recall of a document binding carries the revision a save is checked against", async () => {
    const stub = await configured();
    const document = await created(stub, "workshop", { text: "v1", summary: "one" });
    await stub.issueGrants("rw", [{ resource: "notes", scope: "document", id: "workshop", access: "read-write" }]);
    await stub.issueGrants("ro", [{ resource: "notes", scope: "document", id: "workshop", access: "read" }]);

    const recalled = await stub.recall("rw", "notes");
    expect(recalled).toEqual({
      kind: "projection",
      projection: {
        text: "v1",
        sources: [{ id: "workshop", title: "Title workshop", revision: "1", updatedAt: "2026-09-10T12:00:00.000Z" }],
        cursor: expect.any(String),
        writable: true,
        revision: "1",
        documentId: "workshop",
      },
    });
    expect(await stub.recall("ro", "notes")).toMatchObject({ kind: "projection", projection: { writable: false, text: "v1" } });

    // The owner edits between the model request and the save: conflict with the current text.
    await stub.replaceDocument("notes", "workshop", { text: "owner edit" }, document.revision, owner);
    expect(await stub.save("rw", "notes", { text: "agent edit" }, "1")).toEqual({
      status: "conflict",
      text: "owner edit",
      summary: "one",
    });
    expect(await stub.save("rw", "notes", { text: "agent edit", summary: "two" }, "2")).toEqual({
      status: "saved",
      revision: "3",
      bytes: 10,
    });
    // A retry with the original revision after a lost reply is a conflict, not a replayed success.
    expect(await stub.save("rw", "notes", { text: "agent edit" }, "2")).toMatchObject({ status: "conflict", text: "agent edit", summary: "two" });
    expect(await stub.save("ro", "notes", { text: "x" }, "3")).toEqual({ status: "rejected", reason: "read_only", bound: [] });
    expect(await stub.save("rw", "other", { text: "x" }, "3")).toEqual({ status: "rejected", reason: "not_bound", bound: ["notes"] });
  });

  it("rejects saves the policy, the limit or a deletion forbid", async () => {
    const stub = await configured([{ ...notes, maxBytes: 16 }]);
    const document = await created(stub, "workshop");
    await stub.issueGrants("s-1", [{ resource: "notes", scope: "document", id: "workshop", access: "read-write" }]);
    expect(await stub.save("s-1", "notes", { text: "x".repeat(17) }, "1")).toEqual({
      status: "rejected",
      reason: "too_large",
      field: "text",
      bytes: 17,
      maxBytes: 16,
    });
    expect(await stub.save("s-1", "notes", { text: "ok", summary: "s".repeat(241) }, "1")).toMatchObject({
      status: "rejected",
      reason: "too_large",
      field: "summary",
      maxBytes: 240,
    });
    const frozen = await stub.patchDocument("notes", "workshop", { agentWrites: "disabled" }, document.revision, owner);
    expect(frozen).toMatchObject({ kind: "written" });
    expect(await stub.recall("s-1", "notes")).toMatchObject({ kind: "projection", projection: { writable: false } });
    // Frozen wins over stale: the model is told it cannot write, not to reconcile.
    expect(await stub.save("s-1", "notes", { text: "x" }, "1")).toEqual({ status: "rejected", reason: "agent_writes_disabled" });
    await stub.patchDocument("notes", "workshop", { agentWrites: "enabled" }, "2", owner);
    expect(await stub.save("s-1", "notes", { text: "x" }, "3")).toMatchObject({ status: "saved" });
    await stub.deleteDocument("notes", "workshop", "4", owner);
    expect(await stub.save("s-1", "notes", { text: "x" }, "4")).toEqual({ status: "rejected", reason: "not_found" });
    expect(await stub.recall("s-1", "notes")).toEqual({ kind: "rejected", reason: "not_found" });
  });

  it("reads and lists only within the binding", async () => {
    const stub = await configured();
    await created(stub, "workshop", { text: "w" });
    await created(stub, "budget", { text: "b" });
    await stub.deleteDocument("notes", "budget", "1", owner);
    await created(stub, "other", { text: "o" });
    await stub.issueGrants("doc", [{ resource: "notes", scope: "document", id: "workshop", access: "read" }]);
    await stub.issueGrants("col", [{ resource: "notes", scope: "collection", access: "read" }]);

    expect(await stub.readDocument("doc", "notes", "workshop")).toMatchObject({ kind: "document", document: { text: "w" } });
    expect(await stub.readDocument("doc", "notes", "other")).toEqual({ kind: "rejected", reason: "not_bound" });
    expect(await stub.listCollection("doc", "notes")).toEqual({ kind: "rejected", reason: "not_bound" });
    expect(await stub.readDocument("col", "notes", "other")).toMatchObject({ kind: "document", document: { text: "o" } });
    expect(await stub.readDocument("col", "notes", "budget")).toEqual({ kind: "deleted" });
    expect(await stub.readDocument("col", "notes", "absent")).toEqual({ kind: "missing" });
    expect(await stub.readDocument("nobody", "notes", "workshop")).toEqual({ kind: "rejected", reason: "not_bound" });
    expect(await stub.listCollection("col", "notes")).toMatchObject({
      documents: [{ id: "other" }, { id: "workshop" }],
      nextCursor: null,
    });
    expect(await stub.listCollection("col", "notes", "garbage")).toEqual({ kind: "rejected", reason: "invalid_cursor" });
    expect(await stub.listCollection("col", "elsewhere")).toEqual({ kind: "rejected", reason: "not_bound" });
  });
});
