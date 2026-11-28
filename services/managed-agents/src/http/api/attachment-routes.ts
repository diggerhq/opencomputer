// The attachment routes (work 126, section 4): Org's rows and the object store, as the caller's
// principal. No code of ours carries an attachment's bytes: the uploader sends the file to a signed
// URL of the store and a reader fetches it from one; these routes make the row, hand out the URLs
// and check what arrived.
//
//   PUT    /sessions/{sid}/attachments/{id}            the row from `{name, mimetype, bytes}`, and where to upload
//   POST   /sessions/{sid}/attachments/{id}/complete   the object is there and of the declared size: `ready`
//   GET    /sessions/{sid}/attachments                 the session's rows
//   GET    /sessions/{sid}/attachments/{id}            one row
//   GET    /sessions/{sid}/attachments/{id}/url        a signed URL of the bytes; inline only for raster images
//   DELETE /sessions/{sid}/attachments/{id}            the row `deleted`, the object's delete owed

import type { ActorEnv } from "../../actors/addresses.js";
import { callerOrigin } from "./attachment-objects.js";
import { ATTACHMENT_BYTES_MAX, attachmentKey, attachmentsOf, type Attachment, type Attachments, type AttachmentsEnv as StoreEnv, type OrgRpc } from "../../actors/org/contract.js";
import type { Principal } from "../../auth/principal.js";
import { isId } from "../../ids/session-ids.js";
import { asObject, bodyOf } from "./request-body.js";
import { refusalOf, type Reply } from "./reply.js";
import { timedDo } from "./request-facts.js";
import type { Route } from "./route-table.js";

/** The store's configuration (work 126); a stack without it has no attachments: an upload answers `unavailable`. */
export type AttachmentsEnv = ActorEnv & StoreEnv;

export { ATTACHMENT_BYTES_MAX };
/** Served `inline`: raster images only; everything else (SVG, HTML, PDF, …) is `attachment` (section 8). */
export const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const NAME_MAX = 255;
const RETRY_AFTER_MS = 5_000;
/** An upload URL lives long enough for the largest file on a slow line; the store checks it when the request starts. */
const UPLOAD_URL_S = 60 * 60;
/** A download URL is asked for when it is needed. */
const DOWNLOAD_URL_S = 5 * 60;

/** The store of a request's env; its own URLs, if it makes them, are on the origin the request came to. */
export const storeOf = (env: AttachmentsEnv & { COMPUTER_PUBLIC_ORIGIN?: string }, request: Request): Attachments | null => attachmentsOf(env, callerOrigin(request, env));

/** A media type, lower-cased, without parameters; null when it is not one. */
export function mediaTypeOf(value: unknown): string | null {
  const type = typeof value === "string" ? (value.split(";")[0]?.trim().toLowerCase() ?? "") : "";
  return /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,128}$/.test(type) ? type : null;
}

/** A name is the uploader's, never a path (section 8): no separators, no control characters, 1 to 255 characters. */
export const isName = (name: unknown): name is string =>
  typeof name === "string" && name.length >= 1 && name.length <= NAME_MAX && !/[/\\\x00-\x1f\x7f]/.test(name) && name !== "." && name !== "..";

/** `filename*` of a served `content-disposition`: every byte outside the attr-char set percent-encoded. */
const encodedName = (name: string): string => encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const noStore = (out: Reply) => out.error(503, "unavailable", "Attachments are not available on this deployment.", { retryAfterMs: RETRY_AFTER_MS });
const storeFailed = (out: Reply) => out.error(503, "unavailable", "The attachments' store did not answer.", { retryAfterMs: RETRY_AFTER_MS });
const expiresAt = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

// ------------------------------------------------------------------ the routes

/** An attachment route (`attachments.*`); `routeApi` checked its scope, `actorRoute` the session id's shape. */
export async function attachmentRoute(request: Request, env: AttachmentsEnv, p: Principal, route: Route, org: () => OrgRpc, out: Reply): Promise<Response> {
  const sessionId = route.sessionId!;
  if (route.op === "attachments.list") {
    const r = await timedDo(out.facts, org().attachmentList(p, sessionId));
    return r.ok ? out.send(200, { attachments: r.attachments }) : refusalOf(out, r);
  }
  const id = route.sub!;
  if (!isId("at", id)) return out.error(404, "attachment_not_found", "No such attachment.");
  switch (route.op) {
    case "attachments.put":
      return put(request, env, p, sessionId, id, org, out);
    case "attachments.complete":
      return complete(request, env, p, sessionId, id, org, out);
    case "attachments.get": {
      const r = await timedDo(out.facts, org().attachmentRead(p, sessionId, id));
      return r.ok ? out.send(200, { attachment: r.attachment }) : refusalOf(out, r);
    }
    case "attachments.url":
      return url(request, env, p, sessionId, id, org, out);
    case "attachments.delete": {
      const r = await timedDo(out.facts, org().attachmentDelete(p, sessionId, id));
      return r.ok ? out.send(204, null) : refusalOf(out, r);
    }
    default:
      return out.error(404, "not_found", "No such route.");
  }
}

/**
 * `PUT …/{id}`: the row from the body (Org checks who may, takes the quota) and a signed URL that
 * takes the file. The same body again answers the same row, with a new URL while it is `uploading`.
 */
async function put(request: Request, env: AttachmentsEnv, p: Principal, sessionId: string, id: string, org: () => OrgRpc, out: Reply): Promise<Response> {
  const parsed = await bodyOf(request);
  if ("error" in parsed) return out.error(...parsed.error);
  const body = asObject(parsed.value);
  if (!body) return out.error(400, "invalid_request", "The body must be a JSON object.", { field: "" });
  const mimetype = mediaTypeOf(body.mimetype);
  if (!mimetype) return out.error(400, "invalid_request", "mimetype is the attachment's media type.", { field: "mimetype" });
  const bytes = body.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return out.error(400, "invalid_request", "bytes is the attachment's size in bytes.", { field: "bytes" });
  if (bytes > ATTACHMENT_BYTES_MAX) return out.error(413, "attachment_too_large", `An attachment is at most ${ATTACHMENT_BYTES_MAX} bytes.`, { max: ATTACHMENT_BYTES_MAX, bytes });
  const name = body.name;
  if (!isName(name)) return out.error(400, "invalid_request", "name is the file's name: 1 to 255 characters, no path separators.", { field: "name" });
  // Before the row: one made where nothing can take its bytes would only hold quota.
  const store = storeOf(env, request);
  if (!store) return noStore(out);

  const made = await timedDo(out.facts, org().attachmentCreate(p, sessionId, id, { name, mimetype, bytes }));
  if (!made.ok) return refusalOf(out, made);
  if (!made.created) out.facts.replayed = true;
  if (made.attachment.state !== "uploading") return out.send(200, { attachment: made.attachment });
  const signed = await store.uploadUrl(attachmentKey(p.org, sessionId, id), { bytes, contentType: mimetype }, UPLOAD_URL_S);
  return out.send(made.created ? 201 : 200, { attachment: made.attachment, upload: { url: signed.url, method: "PUT", headers: signed.headers, expiresAt: expiresAt(UPLOAD_URL_S) } });
}

/**
 * `POST …/{id}/complete`: the uploader says the file is sent. The store is asked: an object of the
 * declared size makes the row `ready`; one of another size is deleted. The upload URL is signed
 * for the declared length, so the second is a store that does not hold to it.
 */
async function complete(request: Request, env: AttachmentsEnv, p: Principal, sessionId: string, id: string, org: () => OrgRpc, out: Reply): Promise<Response> {
  const store = storeOf(env, request);
  const key = attachmentKey(p.org, sessionId, id);
  const r = await timedDo(out.facts, org().attachmentRead(p, sessionId, id));
  if (!r.ok) {
    // Deleted while it uploaded: Org's owed delete may have run before the object arrived.
    if (r.code === "attachment_deleted") await store?.delete(key).catch(() => undefined);
    return refusalOf(out, r);
  }
  if (r.attachment.state !== "uploading") return out.send(200, { attachment: r.attachment });
  if (!store) return noStore(out);
  let object;
  try {
    object = await store.head(key);
  } catch {
    return storeFailed(out);
  }
  if (!object) return out.error(409, "attachment_not_uploaded", "The attachment's bytes are not in the store.", { attachmentId: id });
  if (object.bytes !== r.attachment.bytes) {
    await store.delete(key).catch(() => undefined);
    return out.error(400, "content_mismatch", "The uploaded file is not the declared size.", { field: "bytes", bytes: object.bytes });
  }
  const ready = await timedDo(out.facts, org().attachmentReady(id, object.etag));
  if (!ready.ok) {
    if (ready.code === "attachment_deleted") await store.delete(key).catch(() => undefined);
    return refusalOf(out, ready);
  }
  return out.send(200, { attachment: ready.attachment });
}

/**
 * `GET …/{id}/url`: the row (Org judges who may read), then a signed URL that serves the object
 * with the row's `content-type`, `inline` for raster images only, `attachment` when asked.
 */
async function url(request: Request, env: AttachmentsEnv, p: Principal, sessionId: string, id: string, org: () => OrgRpc, out: Reply): Promise<Response> {
  const r = await timedDo(out.facts, org().attachmentRead(p, sessionId, id));
  if (!r.ok) return refusalOf(out, r);
  const a = r.attachment;
  if (a.state === "uploading") return out.error(409, "attachment_not_ready", "The attachment is still uploading.", { attachmentId: id });
  const store = storeOf(env, request);
  if (!store) return noStore(out);
  const download = new URL(request.url).searchParams.get("disposition") === "attachment";
  const signed = await store.downloadUrl(attachmentKey(p.org, sessionId, id), { contentType: a.mimetype, disposition: dispositionOf(a, download) }, DOWNLOAD_URL_S);
  return out.send(200, { url: signed, expiresAt: expiresAt(DOWNLOAD_URL_S) });
}

const dispositionOf = (a: Attachment, download: boolean): string => `${!download && INLINE_TYPES.has(a.mimetype) ? "inline" : "attachment"}; filename*=UTF-8''${encodedName(a.name)}`;
