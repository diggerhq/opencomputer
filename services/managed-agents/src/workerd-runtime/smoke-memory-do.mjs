import { DurableObject } from "cloudflare:workers";

/**
 * A stand-in for the edge worker's MemoryDurableObject, bound to the runtime
 * under the MEMORY namespace exactly as production binds the real class
 * (another worker's class, reached through RPC). It implements the executing
 * session half of the contract with the documented CAS and policy rules, and
 * an owner HTTP surface the smoke uses to seed, edit and inspect documents.
 *
 * State lives in the object's storage so a Miniflare eviction cannot change
 * what the smoke observes.
 */
export class FakeMemoryDurableObject extends DurableObject {
  async state() {
    return (await this.ctx.storage.get("state")) ?? {
      documents: {},
      calls: [],
      revisions: 0,
    };
  }

  async commit(state) {
    await this.ctx.storage.put("state", state);
  }

  key(resource, id) {
    return `${resource}/${id}`;
  }

  async record(state, call) {
    state.calls.push(call);
    await this.commit(state);
    return call.result;
  }

  async recall(sessionId, resource) {
    const state = await this.state();
    const document = Object.values(state.documents).find(
      (candidate) => candidate.resource === resource && !candidate.deleted,
    );
    if (!document) {
      return this.record(state, {
        op: "recall",
        sessionId,
        resource,
        result: { kind: "rejected", reason: "not_found" },
      });
    }
    return this.record(state, {
      op: "recall",
      sessionId,
      resource,
      result: {
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
          cursor: `cursor-${document.revision}`,
          writable: document.agentWrites === "enabled",
          revision: document.revision,
          documentId: document.id,
        },
      },
    });
  }

  async save(sessionId, resource, input, expectedRevision) {
    const state = await this.state();
    const document = Object.values(state.documents).find(
      (candidate) => candidate.resource === resource && !candidate.deleted,
    );
    const done = (result) =>
      this.record(state, { op: "save", sessionId, resource, expectedRevision, input, result });
    if (!document) return done({ status: "rejected", reason: "not_found" });
    if (document.agentWrites === "disabled") {
      return done({ status: "rejected", reason: "agent_writes_disabled" });
    }
    if (document.revision !== expectedRevision) {
      return done({ status: "conflict", text: document.text, summary: document.summary });
    }
    const bytes = new TextEncoder().encode(input.text).byteLength;
    if (bytes > 8192) return done({ status: "rejected", reason: "too_large", field: "text", bytes, maxBytes: 8192 });
    document.text = input.text;
    if (input.summary !== undefined) document.summary = input.summary;
    document.revision = `rev-${String(++state.revisions)}`;
    document.updatedAt = new Date().toISOString();
    document.writer = { kind: "agent", sessionId };
    return done({ status: "saved", revision: document.revision, bytes });
  }

  async readDocument(sessionId, resource, id) {
    const state = await this.state();
    const document = state.documents[this.key(resource, id)];
    return this.record(state, {
      op: "readDocument",
      sessionId,
      resource,
      result: !document
        ? { kind: "missing" }
        : document.deleted
          ? { kind: "deleted" }
          : { kind: "document", document },
    });
  }

  async listCollection(sessionId, resource) {
    const state = await this.state();
    const documents = Object.values(state.documents).filter(
      (candidate) => candidate.resource === resource && !candidate.deleted,
    );
    return this.record(state, {
      op: "listCollection",
      sessionId,
      resource,
      result: { documents, nextCursor: null },
    });
  }

  /** Owner surface: the smoke seeds and edits documents here, outside any session. */
  async fetch(request) {
    const url = new URL(request.url);
    const state = await this.state();
    if (request.method === "POST" && url.pathname === "/documents") {
      const body = await request.json();
      const document = {
        resource: body.resource,
        id: body.id,
        title: body.title ?? body.id,
        text: body.text ?? "",
        summary: body.summary ?? "",
        agentWrites: body.agentWrites ?? "enabled",
        revision: `rev-${String(++state.revisions)}`,
        updatedAt: new Date().toISOString(),
        writer: { kind: "owner" },
        deleted: false,
      };
      state.documents[this.key(body.resource, body.id)] = document;
      await this.commit(state);
      return Response.json(document, { status: 201 });
    }
    if (request.method === "PUT" && url.pathname === "/documents") {
      const body = await request.json();
      const document = state.documents[this.key(body.resource, body.id)];
      if (!document) return Response.json({ error: "not_found" }, { status: 404 });
      document.text = body.text;
      if (body.summary !== undefined) document.summary = body.summary;
      if (body.agentWrites !== undefined) document.agentWrites = body.agentWrites;
      document.revision = `rev-${String(++state.revisions)}`;
      document.updatedAt = new Date().toISOString();
      document.writer = { kind: "owner" };
      await this.commit(state);
      return Response.json(document);
    }
    if (request.method === "GET" && url.pathname === "/documents") {
      const document = state.documents[this.key(url.searchParams.get("resource"), url.searchParams.get("id"))];
      return document ? Response.json(document) : Response.json({ error: "not_found" }, { status: 404 });
    }
    if (request.method === "GET" && url.pathname === "/calls") {
      return Response.json(state.calls);
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}

/** Routes owner requests to the object named by the `object` query parameter. */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const name = url.searchParams.get("object");
    if (!name) return Response.json({ error: "object is required" }, { status: 400 });
    const stub = env.MEMORY.get(env.MEMORY.idFromName(name));
    return stub.fetch(request);
  },
};
