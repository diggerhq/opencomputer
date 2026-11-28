// Pending attachments (work 126): a file attached to a message not yet sent. The upload starts at
// once, ahead of the message (D2); the message's queue entry waits for its ids to be `ready`
// (queue.ts). Our API never carries the bytes: they go straight to the store by a signed URL.
//
// Uploading, at most `UPLOADS_AT_ONCE` at a time, in three steps:
//   1. `PUT /sessions/{sid}/attachments/{id}` with `{ name, mimetype, bytes }` makes the row and
//      answers `upload: { url, headers }` (nothing to upload when the row is already `ready`);
//   2. `PUT upload.url` with the file and exactly those headers, without credentials, through
//      `uploadTo` (XMLHttpRequest in a browser, for progress) or `fetch`;
//   3. `POST …/{id}/complete` makes it `ready`.
// A network error, a 5xx and a 429 other than the quota, at any step: `queued` again, after 1 s
// doubling to 60 s, or at once when the client comes online. A 403 from step 2 (the URL expired),
// and a step 3 that finds the bytes missing or of another size: again from step 1, a few times.
// `410` anywhere: `failed`, the file expired on the server and is attached again by the person.
// Any other 4xx (`413 attachment_too_large`, `429 attachment_quota`): `failed`, with the server's
// reason; the person removes the chip to send. No limit is checked here: the server refuses at
// step 1, before a byte is sent.
//
// Storage. The bytes are held in memory, for this page's life. The small record is in storage
// under `att/<id>`, so a chip survives a reload: a `ready` one stays `ready` (the bytes are on the
// server), any other is `failed` with `attachment_lost`. That is also the rule across tabs: a
// client only uploads what was attached in it. Records older than a day are dropped at load (the
// server has swept their rows), so ones no draft names cannot pile up.
//
// Leaving. `forget` once the message was accepted (its rows are `attached` and live with the
// session); `remove` when the person takes the chip out (the server's row is deleted, best effort).

import { refusal, transient, type Ctx, type Reply } from "./ctx.js";
import { makeId } from "./ids.js";
import { emitter, signal, type Emitter, type WritableSignal } from "./signal.js";
import { Refused, type PendingAttachment, type Signal, type UploadRequest } from "./client-interface.js";

/** Ids a message may carry (edge and SDK). */
export const ATTACHMENTS_PER_MESSAGE = 10;
/** Uploads in flight at once. */
const UPLOADS_AT_ONCE = 2;
/** How long a record is kept: the server sweeps a row no message took after this. */
const RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Times an upload starts again from its first step (an expired URL, bytes the server did not find). */
const RESTARTS = 3;
/** A signed URL is not handed out this close to its end. */
const URL_MARGIN_MS = 30_000;

const LOST = { code: "attachment_lost", reason: "the upload was interrupted: attach the file again" };
const EXPIRED = { code: "attachment_deleted", reason: "the file expired before it was sent: attach it again" };
/** A message's refusals that are about one of its files. */
const FILE_REFUSALS = new Set(["attachment_deleted", "attachment_not_found", "attachment_not_ready"]);

/** What storage holds for a pending attachment. `uploading` is never stored. */
export interface StoredAttachment {
  id: string;
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
  remove(id: string): Promise<void>;
  /** A signed URL of an attachment of a message, kept until shortly before it ends. */
  url(sessionId: string, id: string, download: boolean): Promise<string>;
  /** Every id is `ready`. */
  ready(ids: string[]): boolean;
  /** Why a message naming these ids cannot go: one is `failed` or no longer here. */
  refusal(ids: string[]): Refused | null;
  /** The server refused a message naming these ids: the ones it is about are `failed`, with its reason. */
  refused(ids: string[], error: Refused): void;
  /** The message was accepted: the files and records go. */
  forget(ids: string[]): void;
  /** Start whatever upload can start. */
  pump(): void;
}

const key = (id: string) => `att/${id}`;
const path = (sessionId: string, id: string) => `/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(id)}`;

/** The default `uploadTo`: no progress, and never a credential (the URL is its own authority). */
const plainUpload = (url: string, req: UploadRequest) =>
  fetch(url, { method: req.method, headers: req.headers, body: req.body, signal: req.signal, credentials: "omit" });

export function createAttachments(ctx: Ctx): Attachments {
  const records = new Map<string, StoredAttachment>();
  const views = new Map<string, WritableSignal<PendingAttachment>>();
  /** The bytes of what was attached in this page; a reload loses them. */
  const blobs = new Map<string, Blob>();
  const running = new Set<string>();
  const aborts = new Map<string, AbortController>();
  const urls = new Map<string, { url: Promise<string>; until: number }>();
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
  function set(id: string, change: { state?: PendingAttachment["state"]; progress?: number; error?: StoredAttachment["error"] }): void {
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
    blobs.delete(id);
    ctx.write([{ delete: key(id) }]);
    publish();
  }

  /** The file's bytes to the signed URL. Null when the network failed. */
  async function sendBytes(a: StoredAttachment, blob: Blob, to: { url: string; headers?: Record<string, string> }, signal: AbortSignal): Promise<number | null> {
    let last = -1;
    const onProgress = (sent: number, total: number) => {
      const p = total > 0 ? Math.min(1, sent / total) : 0;
      // Told at every percent, not at every chunk.
      if (Math.floor(p * 100) === last) return;
      last = Math.floor(p * 100);
      set(a.id, { progress: p });
    };
    const req: UploadRequest = { method: "PUT", headers: to.headers ?? {}, body: blob, onProgress, signal };
    try {
      const res = await (ctx.o.uploadTo ?? plainUpload)(to.url, req);
      // The store's reply is not ours to read: its status says it all.
      await res.body?.cancel().catch(() => {});
      return res.status;
    } catch {
      return null;
    }
  }

  async function upload(id: string): Promise<void> {
    running.add(id);
    const retry = ctx.backoff();
    let restarts = 0;
    /** The bytes are in the store: only the last step is left. */
    let sent = false;
    try {
      for (let a = records.get(id); a && !ctx.closed; a = records.get(id)) {
        const blob = blobs.get(id);
        if (!blob) return set(id, { state: "failed", error: LOST });
        const ac = new AbortController();
        aborts.set(id, ac);
        set(id, { state: "uploading", progress: sent ? 1 : 0 });
        const here = () => !ctx.closed && records.has(id);
        const again = async () => {
          set(id, { state: "queued", progress: 0 });
          await retry.wait();
        };
        /** From the first step, at once the first time. Answers false when it has been tried enough. */
        const restart = async () => {
          sent = false;
          if (restarts++ >= RESTARTS) return false;
          if (restarts > 1) await again();
          return true;
        };
        const json = { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: a.name, mimetype: a.mimetype, bytes: a.bytes }), signal: ac.signal };

        let reply: Reply | null = null;
        if (!sent) {
          reply = await ctx.request(path(a.sessionId, id), json).catch(() => null);
          if (!here()) return;
          const to = reply?.body?.upload as { url: string; headers?: Record<string, string> } | undefined;
          if (reply && reply.status < 300 && to) {
            const status = await sendBytes(a, blob, to, ac.signal);
            if (!here()) return;
            if (status === 403) {
              // The URL expired on the way: a new one.
              if (await restart()) continue;
              return set(id, { state: "failed", error: { code: "upload_refused", reason: "the upload was refused: attach the file again" } });
            }
            if (status === null || transient(status)) {
              await again();
              continue;
            }
            if (status >= 300) return set(id, { state: "failed", error: { code: `http_${status}`, reason: "the upload was refused" } });
            sent = true;
          } else if (reply && reply.status < 300) {
            // No `upload`: the row is `ready` already (this id was completed before).
            return set(id, { state: "ready", progress: 1 });
          }
        }
        if (sent) {
          reply = await ctx.request(`${path(a.sessionId, id)}/complete`, { method: "POST", signal: ac.signal }).catch(() => null);
          if (!here()) return;
          if (reply && reply.status < 300) return set(id, { state: "ready", progress: 1 });
          const code = reply?.body?.error?.code as string | undefined;
          // The store does not hold what was declared: all of it again.
          if (code === "attachment_not_uploaded" || code === "content_mismatch") {
            const why = refusal(reply!);
            if (await restart()) continue;
            return set(id, { state: "failed", error: { code: why.code, reason: why.reason } });
          }
        }
        aborts.delete(id);
        if (reply?.status === 410) return set(id, { state: "failed", error: EXPIRED });
        const code = reply?.body?.error?.code as string | undefined;
        if (!reply || (transient(reply.status) && code !== "attachment_quota")) {
          await again();
          continue;
        }
        const r = refusal(reply);
        return set(id, { state: "failed", error: { code: r.code, reason: r.reason } });
      }
    } finally {
      aborts.delete(id);
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

  return {
    list,
    changed,
    load(stored) {
      loaded = true;
      const stale = stored.filter((a) => ctx.now() - a.at > RECORD_MAX_AGE_MS);
      ctx.write(stale.map((a) => ({ delete: key(a.id) })));
      for (const a of stored) {
        if (stale.includes(a)) continue;
        // Not finished by the page that attached it, which alone has the bytes. Not written: that
        // page may be another tab, still uploading, and its `ready` is what storage should keep.
        const here: StoredAttachment = a.state === "queued" ? { ...a, state: "failed", error: LOST } : a;
        records.set(a.id, here);
        views.set(a.id, signal(view(here, here.state === "ready" ? 1 : 0)));
      }
      publish();
    },
    attach(sessionId, file, name) {
      if (!loaded) throw new Error("the client is not ready: await client.ready before attaching");
      const id = makeId("at", ctx.random);
      const a: StoredAttachment = {
        id,
        sessionId,
        name: name ?? (file as File).name ?? "file",
        mimetype: file.type || "application/octet-stream",
        bytes: file.size,
        state: "queued",
        at: ctx.now(),
      };
      records.set(id, a);
      blobs.set(id, file);
      const s = signal(view(a, 0));
      views.set(id, s);
      ctx.write([{ put: key(id), value: a }]);
      publish();
      pump();
      return { id, state: s };
    },
    async remove(id) {
      const a = records.get(id);
      if (!a) return;
      // A file the server refused has no row there; an interrupted one may.
      const onServer = a.state !== "failed" || a.error?.code === LOST.code;
      drop(id);
      changed.emit();
      if (onServer) await ctx.o.fetch(path(a.sessionId, id), { method: "DELETE" }).catch(() => {});
    },
    url(sessionId, id, download) {
      const k = `${sessionId}/${id}/${download ? "attachment" : "inline"}`;
      const held = urls.get(k);
      if (held && held.until > ctx.now()) return held.url;
      // Asked once however many ask together; kept from the reply until shortly before `expiresAt`.
      const entry = { url: Promise.resolve(""), until: Infinity };
      entry.url = ctx.request(`${path(sessionId, id)}/url${download ? "?disposition=attachment" : ""}`).then((reply) => {
        if (reply.status >= 300) throw refusal(reply);
        const { url, expiresAt } = reply.body as { url: string; expiresAt: string };
        const ends = Date.parse(expiresAt);
        entry.until = (Number.isFinite(ends) ? ends : ctx.now()) - URL_MARGIN_MS;
        return url;
      });
      entry.url.catch(() => {
        if (urls.get(k) === entry) urls.delete(k);
      });
      urls.set(k, entry);
      return entry.url;
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
    refused(ids, error) {
      if (!FILE_REFUSALS.has(error.code)) return;
      // The server names the file (`attachmentId`); when it does not, any of them may be the one.
      const named = (error.detail as { attachmentId?: unknown } | undefined)?.attachmentId;
      const which = typeof named === "string" && ids.includes(named) ? [named] : ids;
      const reason =
        error.code === "attachment_not_ready" ? "the upload did not finish: attach the file again" : error.code === "attachment_deleted" ? EXPIRED.reason : "the file is no longer on the server: attach it again";
      for (const id of which) set(id, { state: "failed", progress: 0, error: { code: error.code, reason } });
    },
    forget(ids) {
      for (const id of ids) if (records.has(id)) drop(id);
    },
    pump,
  };
}
