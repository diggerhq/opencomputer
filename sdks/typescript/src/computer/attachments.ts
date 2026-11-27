// Pending attachments (work 126): a file attached to a message not yet sent. The bytes go to `Files`
// and the upload starts at once, ahead of the message (D2); the message's queue entry waits for its
// ids to be `ready` (queue.ts). Records are in storage under `att/<id>`, so a reload resumes the
// uploads of a draft's files.
//
// Uploading. `PUT /sessions/{sid}/attachments/{id}/content` with the blob as the body, at most
// `UPLOADS_AT_ONCE` at a time, through `upload` (XMLHttpRequest in a browser, for progress) or
// `fetch`. 2xx: `ready`. 5xx, a network error and a 429 other than the quota: `queued` again, after
// 1 s doubling to 60 s, or at once when the client comes online. `410 attachment_deleted` (the
// server swept the row after 24 h): the same local id uploads under a fresh server id, so nothing
// outside this module learns of it. Any other 4xx (`413 attachment_too_large`, `429
// attachment_quota`, `409 attachment_in_use`): `failed`, with the reason; the person removes the
// chip to send.
//
// Leaving. `forget` once the message was accepted (its rows are `attached` and live with the
// session); `remove` when the person takes the chip out (the server's row is deleted, best effort).
//
// The limits are this component's (section 44): a file over `ATTACHMENT_MAX_BYTES`, or pending
// files over `PENDING_ATTACHMENTS_MAX_BYTES` on this device, are refused at `attach`.

import { refusal, transient, type Ctx, type Reply } from "./ctx.js";
import { makeId } from "./ids.js";
import { emitter, signal, type Emitter, type WritableSignal } from "./signal.js";
import { Refused, type Files, type PendingAttachment, type Signal } from "./client-interface.js";

/** Ids a message may carry (edge and SDK). */
export const ATTACHMENTS_PER_MESSAGE = 10;
/** Bytes per attachment: the Workers request body limit on the current plan (work 126, K1). */
export const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
/** Pending files kept on a client's disk. */
export const PENDING_ATTACHMENTS_MAX_BYTES = 200 * 1024 * 1024;
/** Uploads in flight at once. */
export const UPLOADS_AT_ONCE = 2;

/** What storage holds for a pending attachment. `uploading` is never stored: a reload resumes it as `queued`. */
export interface StoredAttachment {
  id: string;
  /** The id the server knows it by: `id`, unless a `410` made it upload again under a new one. */
  remote: string;
  sessionId: string;
  name: string;
  mimetype: string;
  bytes: number;
  state: "queued" | "ready" | "failed";
  error?: { code: string; reason: string };
  at: number;
}

export interface Attachments {
  list: WritableSignal<PendingAttachment[]>;
  /** After a state changed: the queue pumps. */
  changed: Emitter<void>;
  load(stored: StoredAttachment[]): void;
  attach(sessionId: string, file: Blob, name?: string): { id: string; state: Signal<PendingAttachment> };
  file(id: string): Promise<Blob | undefined>;
  remove(id: string): Promise<void>;
  read(sessionId: string, id: string): Promise<Blob>;
  /** Every id is `ready`. */
  ready(ids: string[]): boolean;
  /** Why a message naming these ids cannot go: one is `failed` or no longer here. */
  refusal(ids: string[]): Refused | null;
  /** The ids the server knows these by, for the message's body. */
  remote(ids: string[]): string[];
  /** The message was accepted: the files and records go. */
  forget(ids: string[]): void;
  /** Start whatever upload can start. */
  pump(): void;
}

const key = (id: string) => `att/${id}`;
const path = (a: StoredAttachment) => `/sessions/${encodeURIComponent(a.sessionId)}/attachments/${encodeURIComponent(a.remote)}/content`;

/** RFC 8187 encoding for `filename*`. */
const encodeName = (name: string) => encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function createAttachments(ctx: Ctx, files: Files): Attachments {
  const records = new Map<string, StoredAttachment>();
  const views = new Map<string, WritableSignal<PendingAttachment>>();
  /** Blobs `files.put` could not keep (work 126, K2): held here, lost on reload. */
  const inMemory = new Map<string, Blob>();
  const running = new Set<string>();
  const aborts = new Map<string, AbortController>();
  const list = signal<PendingAttachment[]>([]);
  const changed = emitter<void>();
  let loaded = false;

  const view = (a: StoredAttachment, progress: number): PendingAttachment => {
    const v: PendingAttachment = { id: a.id, sessionId: a.sessionId, name: a.name, mimetype: a.mimetype, bytes: a.bytes, state: a.state, progress };
    if (a.error) v.error = a.error;
    return v;
  };
  const publish = () => list.set([...views.values()].map((s) => s.get()));

  /** A new state, told to everyone and written when it is one storage keeps. */
  function set(id: string, change: { state?: PendingAttachment["state"]; progress?: number; remote?: string; error?: StoredAttachment["error"] }): void {
    const a = records.get(id);
    const s = views.get(id);
    if (!a || !s) return;
    const { progress, state, ...rest } = change;
    const stored: Partial<StoredAttachment> = state === "uploading" ? { ...rest, state: "queued" } : state ? { ...rest, state } : rest;
    const next: StoredAttachment = { ...a, ...stored };
    if (state && state !== "failed") delete next.error;
    records.set(id, next);
    if (Object.keys(stored).length) ctx.write([{ put: key(id), value: next }]);
    s.set({ ...view(next, progress ?? s.get().progress), state: state ?? s.get().state });
    publish();
    if (state) changed.emit();
  }

  function drop(id: string): void {
    aborts.get(id)?.abort();
    aborts.delete(id);
    records.delete(id);
    views.delete(id);
    inMemory.delete(id);
    ctx.write([{ delete: key(id) }]);
    void files.delete(id).catch(() => {});
    publish();
  }

  async function parse(res: Response): Promise<Reply> {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // no body, or not JSON
    }
    return { status: res.status, body };
  }

  async function put(a: StoredAttachment, blob: Blob, ac: AbortController): Promise<Reply> {
    const headers = {
      "content-type": a.mimetype || "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeName(a.name)}`,
    };
    let last = -1;
    const onProgress = (sent: number, total: number) => {
      const p = total > 0 ? Math.min(1, sent / total) : 0;
      // Told at every percent, not at every chunk.
      if (Math.floor(p * 100) === last) return;
      last = Math.floor(p * 100);
      set(a.id, { progress: p });
    };
    const res = ctx.o.upload
      ? await ctx.o.upload(path(a), { method: "PUT", headers, body: blob, onProgress, signal: ac.signal })
      : await ctx.o.fetch(path(a), { method: "PUT", headers, body: blob, signal: ac.signal });
    return parse(res);
  }

  async function upload(id: string): Promise<void> {
    running.add(id);
    const retry = ctx.backoff();
    try {
      for (let a = records.get(id); a && !ctx.closed; a = records.get(id)) {
        const blob = inMemory.get(id) ?? (await files.get(id).catch(() => undefined));
        if (!blob) return set(id, { state: "failed", error: { code: "attachment_lost", reason: "the file is no longer on this device" } });
        const ac = new AbortController();
        aborts.set(id, ac);
        set(id, { state: "uploading", progress: 0 });
        const reply = await put(a, blob, ac).catch(() => null);
        aborts.delete(id);
        if (ctx.closed || !records.has(id)) return;
        if (reply && reply.status < 300) return set(id, { state: "ready", progress: 1 });
        if (reply?.status === 410) {
          // Swept on the server: the same file, a fresh row.
          set(id, { remote: makeId("at", ctx.random), state: "queued", progress: 0 });
          continue;
        }
        const code = reply?.body?.error?.code as string | undefined;
        if (!reply || (transient(reply.status) && code !== "attachment_quota")) {
          set(id, { state: "queued", progress: 0 });
          await retry.wait();
          continue;
        }
        const r = refusal(reply);
        return set(id, { state: "failed", error: { code: r.code, reason: r.reason } });
      }
    } finally {
      running.delete(id);
      pump();
    }
  }

  function pump(): void {
    if (!loaded || ctx.closed) return;
    for (const a of records.values()) {
      if (running.size >= UPLOADS_AT_ONCE) return;
      if (a.state === "queued" && !running.has(a.id)) void upload(a.id);
    }
  }

  const pendingBytes = () => [...records.values()].reduce((n, a) => n + a.bytes, 0);

  return {
    list,
    changed,
    load(stored) {
      loaded = true;
      for (const a of stored) {
        records.set(a.id, a);
        views.set(a.id, signal(view(a, a.state === "ready" ? 1 : 0)));
      }
      publish();
      pump();
    },
    attach(sessionId, file, name) {
      if (!loaded) throw new Error("the client is not ready: await client.ready before attaching");
      const bytes = file.size;
      if (bytes > ATTACHMENT_MAX_BYTES)
        throw new Refused("attachment_too_large", `a file can be at most ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB`);
      if (pendingBytes() + bytes > PENDING_ATTACHMENTS_MAX_BYTES)
        throw new Refused("attachment_budget", `files waiting to be sent can total at most ${Math.round(PENDING_ATTACHMENTS_MAX_BYTES / 1024 / 1024)} MB`);
      const id = makeId("at", ctx.random);
      const a: StoredAttachment = {
        id,
        remote: id,
        sessionId,
        name: name ?? (file as File).name ?? "file",
        mimetype: file.type || "application/octet-stream",
        bytes,
        state: "queued",
        at: ctx.now(),
      };
      records.set(id, a);
      const s = signal(view(a, 0));
      views.set(id, s);
      ctx.write([{ put: key(id), value: a }]);
      publish();
      // The upload reads the blob from `files`, after it is there; a store that cannot hold it
      // (Safari's Blob bugs, K2) leaves it in memory for this page's life.
      void files
        .put(id, file)
        .catch(() => void inMemory.set(id, file))
        .then(pump);
      return { id, state: s };
    },
    async file(id) {
      return inMemory.get(id) ?? files.get(id);
    },
    async remove(id) {
      const a = records.get(id);
      if (!a) return;
      const onServer = a.state === "ready" || running.has(id);
      drop(id);
      changed.emit();
      if (onServer)
        await ctx.o
          .fetch(`/sessions/${encodeURIComponent(a.sessionId)}/attachments/${encodeURIComponent(a.remote)}`, { method: "DELETE" })
          .catch(() => {});
    },
    async read(sessionId, id) {
      const res = await ctx.o.fetch(`/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(id)}/content`);
      if (res.status >= 300) throw refusal(await parse(res));
      return res.blob();
    },
    ready: (ids) => ids.every((id) => records.get(id)?.state === "ready"),
    refusal(ids) {
      for (const id of ids) {
        const a = records.get(id);
        if (!a) return new Refused("attachment_not_found", "a file of this message is no longer here");
        if (a.state === "failed") return new Refused(a.error?.code ?? "attachment_failed", a.error?.reason ?? "a file of this message could not be uploaded");
      }
      return null;
    },
    remote: (ids) => ids.map((id) => records.get(id)?.remote ?? id),
    forget(ids) {
      for (const id of ids) if (records.has(id)) drop(id);
    },
    pump,
  };
}
