import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type {
  Document,
  DocumentPage,
  MemoryBinding,
  ReadOutcome,
  RecallOutcome,
  RejectReason,
  SaveInput,
  SaveResult,
} from "../src/edge/memory-contract.js";
import type { MemoryDurableObject } from "../src/edge/memory-do.js";
import type { SessionAgentRender } from "../src/protocol.js";
import type {
  MemoryClient,
  MemoryClientFactory,
  MemoryScope,
} from "../src/workerd-runtime/memory-client.js";

/**
 * Drives the Workerd session Durable Object's memory path against a scripted
 * Memory client: recall before render, the request snapshot, the three fixed
 * tools and the saved event. The render is the real one (the deployed agent
 * runs in the dynamic worker loader); OpenCode itself is never started, so a
 * "model request" here is one renderAgent call and a "tool call" is one
 * executeMemoryTool call carrying the identifiers OpenCode would pass.
 *
 * Evictions are real: the object is evicted and the next call constructs a
 * fresh activation over the same storage.
 */

interface FakeDocument {
  id: string;
  title: string;
  text: string;
  summary: string;
  revision: string;
  updatedAt: string;
  agentWrites: "enabled" | "disabled";
  deleted: boolean;
}

interface MemoryCall {
  op: "recall" | "save" | "readDocument" | "listCollection";
  sessionId: string;
  resource: string;
  args: unknown[];
  result: unknown;
}

const maxBytes = 8_192;
const listPage = 2;

/** A Memory Durable Object stand-in with the contract's CAS and policy rules and nothing else. */
class FakeMemory {
  readonly calls: MemoryCall[] = [];
  readonly scopes: MemoryScope[] = [];
  readonly documents = new Map<string, Map<string, FakeDocument>>();
  bindings: MemoryBinding[] = [];
  private revisions = 0;
  private clock = Date.UTC(2026, 8, 10, 12, 0, 0);

  readonly factory: MemoryClientFactory = (scope) => {
    this.scopes.push(scope);
    return this.client(scope.sessionId);
  };

  seed(
    resource: string,
    document: Pick<FakeDocument, "id"> & Partial<Omit<FakeDocument, "id">>,
  ): FakeDocument {
    const stored: FakeDocument = {
      title: document.id,
      text: "",
      summary: "",
      agentWrites: "enabled",
      deleted: false,
      ...document,
      id: document.id,
      revision: this.nextRevision(),
      updatedAt: this.tick(),
    };
    this.collection(resource).set(document.id, stored);
    return stored;
  }

  ownerEdit(resource: string, id: string, text: string, summary?: string): FakeDocument {
    const document = this.document(resource, id);
    document.text = text;
    if (summary !== undefined) document.summary = summary;
    document.revision = this.nextRevision();
    document.updatedAt = this.tick();
    return document;
  }

  freeze(resource: string, id: string): void {
    this.document(resource, id).agentWrites = "disabled";
  }

  remove(resource: string, id: string): void {
    this.document(resource, id).deleted = true;
  }

  document(resource: string, id: string): FakeDocument {
    const document = this.collection(resource).get(id);
    if (!document) throw new Error(`No fake document ${resource}/${id}`);
    return document;
  }

  private collection(resource: string): Map<string, FakeDocument> {
    let collection = this.documents.get(resource);
    if (!collection) {
      collection = new Map();
      this.documents.set(resource, collection);
    }
    return collection;
  }

  private nextRevision(): string {
    return `rev-${String(++this.revisions)}`;
  }

  private tick(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  private binding(resource: string): MemoryBinding | undefined {
    return this.bindings.find((binding) => binding.resource === resource);
  }

  private meta(document: FakeDocument): Omit<Document, "text"> {
    return {
      id: document.id,
      title: document.title,
      summary: document.summary,
      agentWrites: document.agentWrites,
      revision: document.revision,
      bytes: new TextEncoder().encode(document.text).byteLength,
      maxBytes,
      updatedAt: document.updatedAt,
      writer: { kind: "owner" },
    };
  }

  private live(resource: string): FakeDocument[] {
    return [...this.collection(resource).values()]
      .filter((document) => !document.deleted)
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
      );
  }

  private client(sessionId: string): MemoryClient {
    const record = <T>(op: MemoryCall["op"], resource: string, args: unknown[], result: T): T => {
      this.calls.push({ op, sessionId, resource, args, result });
      return result;
    };
    const rejected = (reason: RejectReason) => ({ kind: "rejected" as const, reason });
    return {
      recall: async (resource): Promise<RecallOutcome> => {
        const binding = this.binding(resource);
        if (!binding) return record("recall", resource, [], rejected("not_bound"));
        if (binding.scope === "document") {
          const document = this.collection(resource).get(binding.id);
          if (!document || document.deleted) {
            return record("recall", resource, [], rejected("not_found"));
          }
          return record("recall", resource, [], {
            kind: "projection",
            projection: {
              text: document.text,
              sources: [
                {
                  id: document.id,
                  title: document.title,
                  revision: document.revision,
                  updatedAt: document.updatedAt,
                },
              ],
              cursor: `cursor-${resource}-${document.revision}`,
              writable: binding.access === "read-write" && document.agentWrites === "enabled",
              revision: document.revision,
              documentId: document.id,
            },
          });
        }
        const documents = this.live(resource);
        return record("recall", resource, [], {
          kind: "projection",
          projection: {
            text: documents
              .map(
                (document) =>
                  `${document.id} | ${document.title} | ${document.summary} | ${document.updatedAt.slice(0, 10)}`,
              )
              .join("\n"),
            sources: documents.map((document) => ({
              id: document.id,
              title: document.title,
              revision: document.revision,
              updatedAt: document.updatedAt,
            })),
            cursor: `cursor-${resource}-overview`,
            writable: false,
          },
        });
      },
      save: async (resource, input: SaveInput, expectedRevision): Promise<SaveResult> => {
        const args = [input, expectedRevision];
        const binding = this.binding(resource);
        if (!binding || binding.scope !== "document" || binding.access !== "read-write") {
          return record("save", resource, args, {
            status: "rejected",
            reason: "not_bound",
            bound: this.bindings
              .filter((candidate) => candidate.scope === "document" && candidate.access === "read-write")
              .map((candidate) => candidate.resource),
          });
        }
        const document = this.collection(resource).get(binding.id);
        if (!document || document.deleted) {
          return record("save", resource, args, { status: "rejected", reason: "not_found" });
        }
        if (document.agentWrites === "disabled") {
          return record("save", resource, args, {
            status: "rejected",
            reason: "agent_writes_disabled",
          });
        }
        if (document.revision !== expectedRevision) {
          return record("save", resource, args, {
            status: "conflict",
            text: document.text,
            summary: document.summary,
          });
        }
        const bytes = new TextEncoder().encode(input.text).byteLength;
        if (bytes > maxBytes) {
          return record("save", resource, args, {
            status: "rejected",
            reason: "too_large",
            field: "text",
            bytes,
            maxBytes,
          });
        }
        document.text = input.text;
        if (input.summary !== undefined) document.summary = input.summary;
        document.revision = this.nextRevision();
        document.updatedAt = this.tick();
        return record("save", resource, args, {
          status: "saved",
          revision: document.revision,
          bytes,
        });
      },
      readDocument: async (resource, id): Promise<ReadOutcome> => {
        const binding = this.binding(resource);
        if (!binding || binding.scope !== "collection") {
          return record("readDocument", resource, [id], rejected("not_bound"));
        }
        const document = this.collection(resource).get(id);
        if (!document) return record("readDocument", resource, [id], { kind: "missing" });
        if (document.deleted) return record("readDocument", resource, [id], { kind: "deleted" });
        return record("readDocument", resource, [id], {
          kind: "document",
          document: { ...this.meta(document), text: document.text },
        });
      },
      listCollection: async (
        resource,
        cursor,
      ): Promise<DocumentPage | { kind: "rejected"; reason: RejectReason }> => {
        const binding = this.binding(resource);
        if (!binding || binding.scope !== "collection") {
          return record("listCollection", resource, [cursor], rejected("not_bound"));
        }
        const documents = this.live(resource);
        const offset = cursor ? Number(cursor.replace("page-", "")) : 0;
        const page = documents.slice(offset, offset + listPage);
        return record("listCollection", resource, [cursor], {
          documents: page.map((document) => this.meta(document)),
          nextCursor: offset + listPage < documents.length ? `page-${String(offset + listPage)}` : null,
        });
      },
    };
  }
}

/** The Durable Object's private surface the tests reach into. */
interface Host {
  env: Record<string, unknown>;
  memory: MemoryClientFactory;
  ensurePlatformSchema(): void;
  pinMemory(value: unknown): void;
  renderAgent(
    currentInput: { source: string; text?: string },
    sessionID: string,
    transcript?: { assistantMessageIds: readonly string[] },
  ): Promise<SessionAgentRender>;
  memoryToolExposure(
    requestKey: string,
  ): Promise<Map<string, Array<{ resource: string; description: string }>>>;
  executeMemoryTool(
    tool: "memory_save" | "memory_read" | "memory_list",
    input: unknown,
    context: { sessionID: string; messageID: string; id: string },
  ): Promise<{ content: string; metadata: Record<string, unknown> }>;
  drainHostEvents(send: (value: unknown) => void): void;
}

interface SnapshotRow {
  [key: string]: SqlStorageValue;
  request_key: string;
  resource: string;
  session_id: string;
  document_id: string | null;
  revision: string | null;
  projection_json: string;
  cursor: string;
  writable: number;
  selected: number;
}

const encode = (value: string) => btoa(unescape(encodeURIComponent(value)));

/**
 * The deployed agent: selects the memory ids named in the input
 * (`select:a,b`) through definition objects, the way compiled code passes
 * `defineMemory` results, and places each projection in its instructions.
 * The agent-side `useMemory` wrapper is the compiled package's: the host
 * hook returns the projection or undefined, and the wrapper throws for an
 * unbound id before inference.
 */
const artifactBundle = new TextEncoder().encode(
  JSON.stringify({
    version: 1,
    files: [
      {
        path: "agent.js",
        content: encode(`
          import { useInput, useMemory } from "./opencomputer-agent.js";
          export default function agent() {
            const input = useInput();
            const text = input && input.text ? input.text : "";
            const match = /select:([\\w,-]+)/.exec(text);
            const seen = [];
            for (const id of match ? match[1].split(",") : []) {
              const memory = useMemory({ kind: "memory", version: 1, id });
              seen.push(id + "=" + JSON.stringify(memory.text) +
                " writable=" + String(memory.writable) +
                " sources=" + memory.sources.map((source) => source.id).join("|"));
            }
            return "Notes: " + seen.join("; ");
          }
        `),
      },
      {
        path: "opencomputer-agent.js",
        content: encode(`
          const hooks = () => globalThis[Symbol.for("opencomputer.agent-hooks")];
          export const useInput = () => hooks().useInput();
          export const useMemory = (memory) => {
            const memoryId = typeof memory === "string" ? memory : memory && memory.id;
            const projection = hooks().useMemory(memoryId);
            if (!projection || typeof projection !== "object" || typeof projection.text !== "string" ||
                !Array.isArray(projection.sources) || typeof projection.writable !== "boolean") {
              throw new Error("Memory " + JSON.stringify(memoryId) + " is not bound to this session; create the session with a memory binding for it");
            }
            return projection;
          };
        `),
      },
      {
        path: ".opencomputer/reactive.json",
        content: encode(
          JSON.stringify({
            version: 2,
            entry: "../agent.js",
            tools: [],
            connections: [],
            mcpServers: [],
            memory: [
              { id: "library", description: "", provider: { kind: "document", maxBytes: 8192 } },
              { id: "notes", description: "Project notes kept for later work.", provider: { kind: "document", maxBytes: 8192 } },
              { id: "plan", description: "The current plan.", provider: { kind: "document", maxBytes: 8192 } },
            ],
          }),
        ),
      },
    ],
  }),
);

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

const artifacts = {
  fetch: async () => new Response(artifactBundle),
};

/** Memory operations must never reach the sandbox adapter. */
const sandboxGuard = {
  fetch: async () => {
    throw new Error("A memory operation reached the sandbox adapter");
  },
};

const bindings = env as unknown as {
  OPENCODE_SESSIONS: DurableObjectNamespace;
  MEMORY: DurableObjectNamespace<MemoryDurableObject>;
};
const sessions = bindings.OPENCODE_SESSIONS;

const defaultObjectName = "acct:proj:development";
const objectName = defaultObjectName;
const managedSessionId = "managed-1";
const openCodeSessionId = "oc-session";

let counter = 0;

function storage(instance: Host): DurableObjectStorage {
  return (instance as unknown as { ctx: DurableObjectState }).ctx.storage;
}

const notesReadWrite: MemoryBinding = {
  resource: "notes",
  scope: "document",
  id: "workshop",
  access: "read-write",
};
const planReadWrite: MemoryBinding = {
  resource: "plan",
  scope: "document",
  id: "roadmap",
  access: "read-write",
};
const library: MemoryBinding = { resource: "library", scope: "collection", access: "read" };

/**
 * One session Durable Object. With a FakeMemory the scripted client replaces
 * the host's factory; without one the host keeps its own, which reaches the
 * real Memory Durable Object over the MEMORY binding.
 */
class Session {
  readonly stub: DurableObjectStub;
  private calls = 0;

  constructor(
    readonly memory: FakeMemory | undefined,
    readonly sessionId = managedSessionId,
    readonly objectName = defaultObjectName,
  ) {
    this.stub = sessions.getByName(`memory-${String(++counter)}`);
  }

  static async create(
    bindings: MemoryBinding[],
    memory: FakeMemory | "real" = new FakeMemory(),
    scope: { sessionId?: string; objectName?: string } = {},
  ): Promise<Session> {
    const fake = memory === "real" ? undefined : memory;
    if (fake) fake.bindings = bindings;
    const session = new Session(fake, scope.sessionId, scope.objectName);
    const { sessionId, objectName } = session;
    const digest = await sha256(artifactBundle);
    await session.run((instance) => {
      instance.ensurePlatformSchema();
      storage(instance).sql.exec(
        "INSERT INTO workerd_deployment (slot, deployment_json) VALUES (1, ?)",
        JSON.stringify({
          id: "dep_test",
          artifact: { bucket: "test", key: digest, digest, size: artifactBundle.byteLength },
        }),
      );
      instance.pinMemory({ objectName, sessionId, bindings });
    });
    return session;
  }

  /** Runs inside the object; the fakes are bound to whatever activation is live. */
  run<T>(body: (instance: Host) => Promise<T> | T): Promise<T> {
    return runInDurableObject(this.stub, (raw) => {
      const instance = raw as unknown as Host;
      if (instance.env.ARTIFACTS !== artifacts) {
        instance.env = { ...instance.env, ARTIFACTS: artifacts, SANDBOX: sandboxGuard };
      }
      if (this.memory) instance.memory = this.memory.factory;
      return body(instance);
    });
  }

  evict(): Promise<void> {
    return evictDurableObject(this.stub);
  }

  /**
   * One model request: recall, render, snapshot. `assistantMessageIds` are
   * the assistant messages already in the transcript at this request, as
   * the context hook's `messages` carry them.
   */
  render(text: string, assistantMessageIds: readonly string[] = []): Promise<SessionAgentRender> {
    return this.run((instance) =>
      instance.renderAgent({ source: "user", text }, openCodeSessionId, { assistantMessageIds }),
    );
  }

  exposure(requestKey: string): Promise<Record<string, Array<{ resource: string; description: string }>>> {
    return this.run(async (instance) =>
      Object.fromEntries(await instance.memoryToolExposure(requestKey)),
    );
  }

  /** One tool call from the assistant message `messageID`; the result is the parsed tool content. */
  tool(
    tool: "memory_save" | "memory_read" | "memory_list",
    input: Record<string, unknown>,
    messageID = "msg-1",
  ): Promise<Record<string, unknown>> {
    return this.run(async (instance) => {
      const result = await instance.executeMemoryTool(tool, input, {
        sessionID: openCodeSessionId,
        messageID,
        id: `call-${String(++this.calls)}`,
      });
      return JSON.parse(result.content) as Record<string, unknown>;
    });
  }

  save(input: Record<string, unknown>, messageID?: string): Promise<Record<string, unknown>> {
    return this.tool("memory_save", input, messageID);
  }

  snapshots(requestKey?: string): Promise<SnapshotRow[]> {
    return this.run((instance) =>
      storage(instance)
        .sql.exec<SnapshotRow>(
          `SELECT request_key, resource, session_id, document_id, revision,
                  projection_json, cursor, writable, selected
           FROM workerd_request_snapshot
           ${requestKey ? "WHERE request_key = ?" : ""} ORDER BY rowid`,
          ...(requestKey ? [requestKey] : []),
        )
        .toArray(),
    );
  }

  renderCount(): Promise<number> {
    return this.run((instance) =>
      Number(
        storage(instance)
          .sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM workerd_agent_renders")
          .one().count,
      ),
    );
  }

  sandboxLeases(): Promise<number> {
    return this.run((instance) =>
      Number(
        storage(instance)
          .sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM workerd_sandbox_lease")
          .one().count,
      ),
    );
  }

  /** Everything the turn stream would carry from the host since the last drain. */
  drain(): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
    return this.run((instance) => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      instance.drainHostEvents((value) => {
        events.push(value as { type: string; data: Record<string, unknown> });
      });
      return events;
    });
  }
}

function lastSave(memory: FakeMemory | undefined): MemoryCall {
  const call = [...(memory?.calls ?? [])].reverse().find((candidate) => candidate.op === "save");
  if (!call) throw new Error("No save reached the fake");
  return call;
}

function fake(session: Session): FakeMemory {
  if (!session.memory) throw new Error("The session uses the real Memory Durable Object");
  return session.memory;
}

describe("recall before render", () => {
  it("writes the request snapshot with the render and hands the projection to useMemory", async () => {
    const session = await Session.create([notesReadWrite]);
    const seeded = fake(session).seed("notes", {
      id: "workshop",
      title: "Workshop requirements",
      text: "Node.js 22, no paid services.",
    });

    const render = await session.render("select:notes");

    expect(render.instructions).toBe(
      'Notes: notes="Node.js 22, no paid services." writable=true sources=workshop',
    );
    const rows = await session.snapshots(render.renderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      request_key: render.renderId,
      resource: "notes",
      session_id: openCodeSessionId,
      document_id: "workshop",
      revision: seeded.revision,
      writable: 1,
      selected: 1,
      cursor: `cursor-notes-${seeded.revision}`,
    });
    expect(JSON.parse(rows[0]!.projection_json)).toMatchObject({
      text: "Node.js 22, no paid services.",
      sources: [{ id: "workshop", revision: seeded.revision }],
    });
    expect(fake(session).scopes[0]).toEqual({ objectName, sessionId: managedSessionId });
    expect(fake(session).calls.map((call) => [call.op, call.sessionId, call.resource])).toEqual([
      ["recall", managedSessionId, "notes"],
    ]);
  });

  it("recalls every binding and records which ones the render selected", async () => {
    const session = await Session.create([notesReadWrite, planReadWrite, library]);
    fake(session).seed("notes", { id: "workshop", text: "n" });
    fake(session).seed("plan", { id: "roadmap", text: "p" });
    fake(session).seed("library", { id: "budget", title: "Budget", summary: "Q4 in EUR." });

    const render = await session.render("select:plan");

    const rows = await session.snapshots(render.renderId);
    expect(rows.map((row) => [row.resource, row.selected])).toEqual([
      ["library", 0],
      ["notes", 0],
      ["plan", 1],
    ]);
    expect(fake(session).calls.filter((call) => call.op === "recall")).toHaveLength(3);
  });

  it("fails the request when any bound recall is rejected, even one the render would not use", async () => {
    const session = await Session.create([notesReadWrite, planReadWrite]);
    fake(session).seed("notes", { id: "workshop", text: "n" });
    fake(session).seed("plan", { id: "roadmap", text: "p" });
    fake(session).remove("plan", "roadmap");

    await expect(session.render("select:notes")).rejects.toThrow(
      'Memory recall for "plan" was rejected: not_found',
    );
    expect(await session.renderCount()).toBe(0);
    expect(await session.snapshots()).toEqual([]);
  });

  it("rejects a render that selects a memory id the session is not bound to", async () => {
    const session = await Session.create([notesReadWrite]);
    fake(session).seed("notes", { id: "workshop" });

    await expect(session.render("select:plan")).rejects.toThrow(
      'Memory "plan" is not bound to this session',
    );
    expect(await session.renderCount()).toBe(0);
  });

  it("rejects a render that selects a memory id the deployment does not declare", async () => {
    const session = await Session.create([
      { resource: "undeclared", scope: "collection", access: "read" },
    ]);

    await expect(session.render("select:undeclared")).rejects.toThrow(
      "Agent selected an unregistered memory resource",
    );
    expect(await session.renderCount()).toBe(0);
  });
});

describe("memory_save", () => {
  it("uses the snapshot revision and returns the SaveResult verbatim", async () => {
    const session = await Session.create([notesReadWrite]);
    const { revision } = fake(session).seed("notes", { id: "workshop", text: "v1" });
    await session.render("select:notes");

    const result = await session.save({ text: "v2", summary: "Second." });

    const call = lastSave(session.memory);
    expect(call.args).toEqual([{ text: "v2", summary: "Second." }, revision]);
    expect(result).toEqual(call.result);
    expect(result).toEqual({ status: "saved", revision: "rev-2", bytes: 2 });
    expect(fake(session).document("notes", "workshop")).toMatchObject({ text: "v2", summary: "Second." });
  });

  it("gives two saves from one response the same revision, so the second conflicts", async () => {
    const session = await Session.create([notesReadWrite]);
    const { revision } = fake(session).seed("notes", { id: "workshop", text: "v1", summary: "One." });
    await session.render("select:notes");

    const first = await session.save({ text: "v2" }, "msg-1");
    const second = await session.save({ text: "v3" }, "msg-1");

    expect(first).toEqual({ status: "saved", revision: "rev-2", bytes: 2 });
    expect(second).toEqual({ status: "conflict", text: "v2", summary: "One." });
    const revisions = fake(session).calls.filter((call) => call.op === "save").map((call) => call.args[1]);
    expect(revisions).toEqual([revision, revision]);
  });

  it("conflicts after an owner edit between two steps and the next recall shows the new text", async () => {
    const session = await Session.create([notesReadWrite]);
    fake(session).seed("notes", { id: "workshop", text: "v1" });
    await session.render("select:notes");
    fake(session).ownerEdit("notes", "workshop", "owner text", "Owner.");

    const conflicted = await session.save({ text: "agent text" }, "msg-1");
    expect(conflicted).toEqual({ status: "conflict", text: "owner text", summary: "Owner." });

    const next = await session.render("select:notes");
    expect(next.instructions).toContain('notes="owner text"');
    const reconciled = await session.save({ text: "owner text + agent text" }, "msg-2");
    expect(reconciled).toMatchObject({ status: "saved" });
    expect(lastSave(session.memory).args[1]).toBe((await session.snapshots(next.renderId))[0]!.revision);
  });

  it("returns the frozen and deleted outcomes as results, not errors", async () => {
    const session = await Session.create([notesReadWrite]);
    fake(session).seed("notes", { id: "workshop", text: "v1" });
    await session.render("select:notes");
    fake(session).freeze("notes", "workshop");
    expect(await session.save({ text: "v2" })).toEqual({
      status: "rejected",
      reason: "agent_writes_disabled",
    });

    const frozen = await session.render("select:notes");
    expect(frozen.instructions).toContain("writable=false");

    fake(session).remove("notes", "workshop");
    expect(await session.save({ text: "v2" }, "msg-2")).toEqual({
      status: "rejected",
      reason: "not_found",
    });
  });

  it("keeps the persisted snapshot revision across an eviction between the response and the tool call", async () => {
    const session = await Session.create([notesReadWrite]);
    const { revision } = fake(session).seed("notes", { id: "workshop", text: "v1" });
    await session.render("select:notes");

    await session.evict();

    const result = await session.save({ text: "after eviction" });
    expect(result).toEqual({ status: "saved", revision: "rev-2", bytes: 14 });
    expect(lastSave(session.memory).args[1]).toBe(revision);
    expect(await session.sandboxLeases()).toBe(0);
  });
});

describe("stale tool calls (S6 mitigation)", () => {
  it("rejects a delayed tool call from the interrupted turn after a new turn rendered, and saves the new turn's call", async () => {
    const session = await Session.create([notesReadWrite]);
    const { revision } = fake(session).seed("notes", { id: "workshop", text: "v1" });
    // Turn A, step one: no assistant message yet; its model reply is msg-a.
    await session.render("select:notes", []);
    // The user interrupts A and sends a new turn. Turn B's request sees
    // msg-a (with content) in the transcript. The owner edited meanwhile.
    fake(session).ownerEdit("notes", "workshop", "owner text", "Owner.");
    const b = await session.render("select:notes", ["msg-a"]);
    const latest = (await session.snapshots(b.renderId))[0]!.revision;

    // A's delayed tool call arrives now, after B's render: stale, never
    // applied to B's snapshot, not even as a conflict.
    const delayed = await session.save({ text: "from turn A" }, "msg-a");
    expect(delayed).toEqual({ status: "rejected", reason: "stale" });
    expect(fake(session).calls.filter((call) => call.op === "save")).toEqual([]);
    expect(fake(session).document("notes", "workshop")).toMatchObject({ text: "owner text", revision: expect.any(String) });
    expect(await session.tool("memory_read", { id: "workshop" }, "msg-a")).toEqual({ status: "rejected", reason: "stale" });

    // B's own reply (msg-b, not in any recorded set) saves against B's snapshot.
    const fresh = await session.save({ text: "from turn B" }, "msg-b");
    expect(fresh).toEqual({ status: "saved", revision: "rev-3", bytes: 11 });
    expect(lastSave(session.memory).args[1]).toBe(latest);
    expect(latest).not.toBe(revision);
    expect(fake(session).document("notes", "workshop")).toMatchObject({ text: "from turn B" });
  });

  it("keeps the current request's own reply fresh across steps and stales it once a later step rendered", async () => {
    const session = await Session.create([notesReadWrite]);
    fake(session).seed("notes", { id: "workshop", text: "v1" });
    await session.render("select:notes", []);
    expect(await session.save({ text: "step one" }, "msg-1")).toMatchObject({ status: "saved" });
    // Step two of the same turn: msg-1 is in the transcript now.
    await session.render("select:notes", ["msg-1"]);
    expect(await session.save({ text: "late from step one" }, "msg-1")).toEqual({ status: "rejected", reason: "stale" });
    expect(await session.save({ text: "step two" }, "msg-2")).toMatchObject({ status: "saved" });
    // The recorded set survives eviction.
    await session.evict();
    expect(await session.save({ text: "after eviction" }, "msg-1")).toEqual({ status: "rejected", reason: "stale" });
    expect(fake(session).document("notes", "workshop")).toMatchObject({ text: "step two" });
  });
});

describe("the memory argument", () => {
  it("is optional with one writable binding and required with two", async () => {
    const session = await Session.create([notesReadWrite, planReadWrite]);
    fake(session).seed("notes", { id: "workshop", text: "n" });
    fake(session).seed("plan", { id: "roadmap", text: "p" });

    await session.render("select:notes");
    expect(await session.save({ text: "n2" })).toMatchObject({ status: "saved" });
    expect(fake(session).document("notes", "workshop").text).toBe("n2");

    await session.render("select:notes,plan");
    expect(await session.save({ text: "x" }, "msg-2")).toEqual({
      status: "rejected",
      reason: "not_bound",
      bound: ["notes", "plan"],
    });
    expect(await session.save({ text: "p2", memory: "plan" }, "msg-2")).toMatchObject({ status: "saved" });
    expect(fake(session).document("plan", "roadmap").text).toBe("p2");
    expect(fake(session).document("notes", "workshop").text).toBe("n2");
  });

  it("rejects a wrong value with the targets of this request, not every binding", async () => {
    const session = await Session.create([notesReadWrite, planReadWrite]);
    fake(session).seed("notes", { id: "workshop", text: "n" });
    fake(session).seed("plan", { id: "roadmap", text: "p" });
    await session.render("select:notes");

    expect(await session.save({ text: "x", memory: "plan" })).toEqual({
      status: "rejected",
      reason: "not_bound",
      bound: ["notes"],
    });
    expect(await session.save({ text: "x", memory: "elsewhere" })).toEqual({
      status: "rejected",
      reason: "not_bound",
      bound: ["notes"],
    });
    expect(fake(session).calls.filter((call) => call.op === "save")).toHaveLength(0);
  });

  it("offers no save for a read-only document binding", async () => {
    const session = await Session.create([{ ...notesReadWrite, access: "read" }]);
    fake(session).seed("notes", { id: "workshop", text: "n" });
    const render = await session.render("select:notes");

    expect(render.instructions).toContain("writable=false");
    expect(await session.exposure(render.renderId)).toEqual({
      memory_save: [],
      memory_read: [],
      memory_list: [],
    });
    expect(await session.save({ text: "x" })).toEqual({
      status: "rejected",
      reason: "not_bound",
      bound: [],
    });
  });
});

describe("tool exposure", () => {
  it("exposes no memory tools for a render that selects no memory", async () => {
    const session = await Session.create([notesReadWrite, library]);
    fake(session).seed("notes", { id: "workshop", text: "n" });
    const render = await session.render("hello");

    expect(render.instructions).toBe("Notes: ");
    expect((await session.snapshots(render.renderId)).map((row) => row.selected)).toEqual([0, 0]);
    expect(await session.exposure(render.renderId)).toEqual({
      memory_save: [],
      memory_read: [],
      memory_list: [],
    });
    expect(await session.save({ text: "x" })).toEqual({
      status: "rejected",
      reason: "not_bound",
      bound: [],
    });
    expect(await session.tool("memory_list", {})).toEqual({
      status: "rejected",
      reason: "not_bound",
      bound: [],
    });
  });

  it("lists the selected resources with their declared descriptions, falling back to the id when the declaration has none", async () => {
    const session = await Session.create([notesReadWrite, planReadWrite, library]);
    fake(session).seed("notes", { id: "workshop" });
    fake(session).seed("plan", { id: "roadmap" });
    const render = await session.render("select:notes,plan,library");

    expect(await session.exposure(render.renderId)).toEqual({
      memory_save: [
        { resource: "notes", description: "Project notes kept for later work." },
        { resource: "plan", description: "The current plan." },
      ],
      memory_read: [{ resource: "library", description: "library" }],
      memory_list: [{ resource: "library", description: "library" }],
    });
  });
});

describe("collection tools", () => {
  it("projects the overview and reads and lists through the binding", async () => {
    const session = await Session.create([library]);
    fake(session).seed("library", { id: "older", title: "Older", summary: "First." });
    fake(session).seed("library", { id: "budget", title: "Budget", summary: "Q4 in EUR." });
    fake(session).seed("library", {
      id: "workshop",
      title: "Workshop",
      summary: "Node 22.",
      text: "Exercises run on Node.js 22.",
    });
    const render = await session.render("select:library");

    expect(render.instructions).toContain(
      "workshop | Workshop | Node 22. | 2026-09-10\\nbudget | Budget | Q4 in EUR. | 2026-09-10\\nolder | Older | First. | 2026-09-10",
    );
    expect(render.instructions).toContain("writable=false sources=workshop|budget|older");

    const first = await session.tool("memory_list", {});
    expect(first).toEqual({
      documents: [
        { id: "workshop", title: "Workshop", summary: "Node 22.", revision: "rev-3", updatedAt: expect.any(String) },
        { id: "budget", title: "Budget", summary: "Q4 in EUR.", revision: "rev-2", updatedAt: expect.any(String) },
      ],
      nextCursor: "page-2",
    });
    const second = await session.tool("memory_list", { cursor: "page-2" });
    expect(second).toMatchObject({ documents: [{ id: "older" }], nextCursor: null });

    expect(await session.tool("memory_read", { id: "workshop" })).toEqual({
      id: "workshop",
      title: "Workshop",
      text: "Exercises run on Node.js 22.",
      summary: "Node 22.",
      revision: "rev-3",
      updatedAt: expect.any(String),
    });
    expect(await session.tool("memory_read", { id: "missing" })).toEqual({
      status: "rejected",
      reason: "not_found",
    });
    expect(await session.tool("memory_read", { id: "workshop", memory: "notes" })).toEqual({
      status: "rejected",
      reason: "not_bound",
      bound: ["library"],
    });
    expect(fake(session).calls.map((call) => call.op)).toEqual([
      "recall",
      "listCollection",
      "listCollection",
      "readDocument",
      "readDocument",
    ]);
  });
});

describe("the saved event", () => {
  it("is emitted once on the turn stream after a saved result and never for a conflict", async () => {
    const session = await Session.create([notesReadWrite]);
    fake(session).seed("notes", { id: "workshop", text: "v1" });
    const render = await session.render("select:notes");

    expect(await session.save({ text: "v2" })).toMatchObject({ status: "saved" });
    expect(await session.save({ text: "v3" })).toMatchObject({ status: "conflict" });

    const events = await session.drain();
    expect(events.map((event) => event.type)).toEqual([
      "opencomputer.agent.rendered",
      "opencomputer.memory.saved",
    ]);
    expect(events[0]!.data.renderId).toBe(render.renderId);
    expect(events[1]!.data).toEqual({
      resource: "notes",
      documentId: "workshop",
      revision: "rev-2",
      bytes: 2,
    });
    expect(await session.drain()).toEqual([]);
  });

  it("survives an eviction before the stream drains it", async () => {
    const session = await Session.create([notesReadWrite]);
    fake(session).seed("notes", { id: "workshop", text: "v1" });
    await session.render("select:notes");
    await session.save({ text: "v2" });

    await session.evict();

    const events = await session.drain();
    expect(events.map((event) => event.type)).toEqual([
      "opencomputer.agent.rendered",
      "opencomputer.memory.saved",
    ]);
  });
});

describe("memory bindings", () => {
  it("are fixed for the session: the same set again is a no-op, a different set is refused", async () => {
    const session = await Session.create([notesReadWrite, library]);

    await session.run((instance) => {
      instance.pinMemory({ objectName, sessionId: managedSessionId, bindings: [library, notesReadWrite] });
    });
    await expect(
      session.run((instance) => {
        instance.pinMemory({ objectName, sessionId: managedSessionId, bindings: [notesReadWrite] });
      }),
    ).rejects.toThrow("already pinned to different memory bindings");
    await expect(
      session.run((instance) => {
        instance.pinMemory({ objectName: "acct:other:development", sessionId: managedSessionId, bindings: [notesReadWrite, library] });
      }),
    ).rejects.toThrow("already pinned to different memory bindings");
  });

  it("refuses malformed, duplicate or too many bindings", async () => {
    const session = new Session(new FakeMemory());
    await session.run((instance) => instance.ensurePlatformSchema());
    const pin = (value: unknown) => session.run((instance) => instance.pinMemory(value));

    await expect(pin({ objectName, sessionId: managedSessionId })).rejects.toThrow(
      "Memory requires objectName, sessionId and bindings",
    );
    await expect(
      pin({ objectName, sessionId: managedSessionId, bindings: [{ resource: "notes", scope: "collection", access: "read-write" }] }),
    ).rejects.toThrow("document or collection scope");
    await expect(
      pin({ objectName, sessionId: managedSessionId, bindings: [notesReadWrite, { ...notesReadWrite, id: "other" }] }),
    ).rejects.toThrow('"notes" is bound twice');
    await expect(
      pin({
        objectName,
        sessionId: managedSessionId,
        bindings: Array.from({ length: 9 }, (_, index) => ({ resource: `r${String(index)}`, scope: "collection", access: "read" })),
      }),
    ).rejects.toThrow("at most 8 memory resources");
  });
});

describe("with the real Memory Durable Object", () => {
  const document = "workshop";

  /** Admission's side, done directly on a fresh object: configuration, the document and the grants. */
  async function admitted(sessionIds: string[] = [managedSessionId]) {
    const objectName = `acct:prj_${String(++counter)}:development`;
    const memory = bindings.MEMORY.getByName(objectName);
    expect(await memory.applyConfig(1, "dep-1", [{ resource: "notes", provider: "document", maxBytes: 8_192 }])).toMatchObject({ kind: "applied" });
    const created = await memory.createDocument("notes", document, { title: "Workshop", text: "v1" }, { kind: "owner" });
    if (created.kind !== "created") throw new Error(`Create failed: ${JSON.stringify(created)}`);
    for (const sessionId of sessionIds) {
      expect(await memory.issueGrants(sessionId, [notesReadWrite])).toMatchObject({ kind: "issued" });
    }
    return { memory, objectName, document: created.document };
  }

  async function current(memory: DurableObjectStub<MemoryDurableObject>) {
    const outcome = await memory.getDocument("notes", document);
    if (outcome.kind !== "document") throw new Error(`Read failed: ${JSON.stringify(outcome)}`);
    return outcome.document;
  }

  it("recalls, saves and conflicts through the MEMORY binding with the revisions the object issued", async () => {
    const { memory, objectName, document: seeded } = await admitted();
    const session = await Session.create([notesReadWrite], "real", { objectName });

    const first = await session.render("select:notes");
    expect(first.instructions).toBe('Notes: notes="v1" writable=true sources=workshop');
    expect((await session.snapshots(first.renderId))[0]).toMatchObject({
      resource: "notes",
      document_id: document,
      revision: seeded.revision,
      selected: 1,
    });

    const saved = await session.save({ text: "v2", summary: "Second." }, "msg-1");
    expect(saved).toMatchObject({ status: "saved", bytes: 2 });
    expect(await current(memory)).toMatchObject({
      text: "v2",
      summary: "Second.",
      revision: saved.revision,
      writer: { kind: "agent", sessionId: managedSessionId },
    });

    // The same response saving again carries the request's revision, not the new one.
    expect(await session.save({ text: "v3" }, "msg-1")).toEqual({
      status: "conflict",
      text: "v2",
      summary: "Second.",
    });

    // Next step: fresh recall, then an owner edit during inference.
    const second = await session.render("select:notes");
    expect(second.instructions).toContain('notes="v2"');
    const edited = await memory.replaceDocument("notes", document, { text: "owner text" }, String(saved.revision), { kind: "owner" });
    expect(edited.kind).toBe("written");
    expect(await session.save({ text: "agent text" }, "msg-2")).toEqual({
      status: "conflict",
      text: "owner text",
      summary: "Second.",
    });
    const third = await session.render("select:notes");
    expect(third.instructions).toContain('notes="owner text"');
    expect(await session.save({ text: "owner text, then agent text" }, "msg-3")).toMatchObject({ status: "saved" });
    expect((await current(memory)).text).toBe("owner text, then agent text");

    const events = await session.drain();
    expect(events.filter((event) => event.type === "opencomputer.memory.saved").map((event) => event.data)).toEqual([
      { resource: "notes", documentId: document, revision: saved.revision, bytes: 2 },
      { resource: "notes", documentId: document, revision: (await current(memory)).revision, bytes: 27 },
    ]);
  });

  it("keeps the recalled revision across evicting both objects between the response and the tool call", async () => {
    const { memory, objectName, document: seeded } = await admitted();
    const session = await Session.create([notesReadWrite], "real", { objectName });
    await session.render("select:notes");

    await session.evict();
    await evictDurableObject(memory);

    const saved = await session.save({ text: "after both evictions" });
    expect(saved).toMatchObject({ status: "saved" });
    const stored = await current(bindings.MEMORY.getByName(objectName));
    expect(stored.text).toBe("after both evictions");
    expect(stored.revision).not.toBe(seeded.revision);
  });

  it("reports a frozen document as not writable and rejects its pending save", async () => {
    const { memory, objectName, document: seeded } = await admitted();
    const session = await Session.create([notesReadWrite], "real", { objectName });
    await session.render("select:notes");

    expect(await memory.patchDocument("notes", document, { agentWrites: "disabled" }, seeded.revision, { kind: "owner" })).toMatchObject({ kind: "written" });
    expect(await session.save({ text: "v2" })).toEqual({ status: "rejected", reason: "agent_writes_disabled" });

    const frozen = await session.render("select:notes");
    expect(frozen.instructions).toContain("writable=false");
    expect((await session.exposure(frozen.renderId)).memory_save).toEqual([
      { resource: "notes", description: "Project notes kept for later work." },
    ]);
  });

  it("lets a second session read the first session's save and refuses a closed session before inference", async () => {
    const { memory, objectName } = await admitted([managedSessionId, "managed-2"]);
    const first = await Session.create([notesReadWrite], "real", { objectName });
    await first.render("select:notes");
    expect(await first.save({ text: "from the first session" })).toMatchObject({ status: "saved" });

    const second = await Session.create([notesReadWrite], "real", { objectName, sessionId: "managed-2" });
    const render = await second.render("select:notes");
    expect(render.instructions).toContain('notes="from the first session"');

    expect(await memory.closeSession(managedSessionId)).toEqual({ closed: true });
    await expect(first.render("select:notes")).rejects.toThrow(
      'Memory recall for "notes" was rejected: session_closed',
    );
    expect(await first.save({ text: "after close" })).toEqual({
      status: "rejected",
      reason: "session_closed",
    });
    expect((await current(memory)).text).toBe("from the first session");
  });
});
