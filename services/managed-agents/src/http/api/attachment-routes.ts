// The attachment routes (work 126, section 4): Org's rows and the object store, as the caller's
// principal. No actor holds an attachment's bytes: `PUT …/content` streams the request's body into
// the store and `GET …/content` streams the object out, this handler in between.
//
//   PUT    /sessions/{sid}/attachments/{id}/content   the row from the headers, then the body → store
//   GET    /sessions/{sid}/attachments                 the session's rows
//   GET    /sessions/{sid}/attachments/{id}            one row
//   GET    /sessions/{sid}/attachments/{id}/content    the bytes, with Range, nosniff; inline only for raster images
//   DELETE /sessions/{sid}/attachments/{id}            the row `deleted`, the object's delete owed

import type { ActorEnv } from "../../actors/addresses.js";
import { attachmentKey, LengthMismatch, r2Attachments, type Attachment, type AttachmentRange, type Attachments, type OrgRpc } from "../../actors/org/contract.js";
import type { Principal } from "../../auth/principal.js";
import { isId } from "../../ids/session-ids.js";
import { refusalOf, type Reply } from "./reply.js";
import { timedDo } from "./request-facts.js";
import type { Route } from "./route-table.js";

export type AttachmentsEnv = ActorEnv & {
  /** The attachments' objects (work 126); absent on a stack without them: every upload answers `unavailable`. */
  ATTACHMENTS?: R2Bucket;
};

/** Bytes of one attachment (section 8): the Workers request body limit on the current plan (K1). */
export const ATTACHMENT_BYTES_MAX = 100 * 1024 * 1024;
/** Served `inline`: raster images only; everything else (SVG, HTML, PDF, …) is `attachment` (section 8). */
export const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const NAME_MAX = 255;
const RETRY_AFTER_MS = 5_000;

/** The store of a request's env; tests replace it. */
export const storeOf = (env: AttachmentsEnv): Attachments | null => (env.ATTACHMENTS ? r2Attachments(env.ATTACHMENTS) : null);

// ------------------------------------------------------------------ the headers

/** The media type of a `content-type`, lower-cased, without parameters; null when it is not one. */
export function mediaTypeOf(header: string | null): string | null {
  const type = header?.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,128}$/.test(type) ? type : null;
}

/** The name a `content-disposition` carries: `filename*=UTF-8''…` (RFC 5987) first, else `filename="…"`. Never a path. */
export function filenameOf(header: string | null): string | null {
  if (!header) return null;
  let name: string | null = null;
  const star = /filename\*\s*=\s*(?:utf-8|UTF-8)''([^;]*)/.exec(header);
  if (star) {
    try {
      name = decodeURIComponent(star[1]!.trim());
    } catch {
      return null;
    }
  } else {
    const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/.exec(header);
    if (!plain) return null;
    name = plain[1] !== undefined ? plain[1].replace(/\\(.)/g, "$1") : plain[2]!.trim();
  }
  return isName(name) ? name : null;
}

/** A name is the uploader's, never a path (section 8): no separators, no control characters, 1 to 255 characters. */
const isName = (name: string): boolean => name.length >= 1 && name.length <= NAME_MAX && !/[/\\\x00-\x1f\x7f]/.test(name) && name !== "." && name !== "..";

/** `filename*` of a served `content-disposition`: every byte outside the attr-char set percent-encoded. */
const encodedName = (name: string): string => encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** A `Range` header as one range of a `size`-byte object (RFC 9110 14.1.2); `unsatisfiable` past the end; null when absent or not one range. */
export function rangeOf(header: string | null, size: number): AttachmentRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    // The last n bytes.
    const n = Number(m[2]);
    if (n === 0 || size === 0) return "unsatisfiable";
    const length = Math.min(n, size);
    return { offset: size - length, length };
  }
  const first = Number(m[1]);
  if (first >= size) return "unsatisfiable";
  const last = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (last < first) return null;
  return { offset: first, length: last - first + 1 };
}

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
    case "attachments.get": {
      const r = await timedDo(out.facts, org().attachmentRead(p, sessionId, id));
      return r.ok ? out.send(200, { attachment: r.attachment }) : refusalOf(out, r);
    }
    case "attachments.content":
      return content(request, env, p, sessionId, id, org, out);
    case "attachments.delete": {
      const r = await timedDo(out.facts, org().attachmentDelete(p, sessionId, id));
      return r.ok ? out.send(204, null) : refusalOf(out, r);
    }
    default:
      return out.error(404, "not_found", "No such route.");
  }
}

/**
 * `PUT …/content`: the row from `content-type`, `content-length` and `content-disposition` (Org
 * checks who may, takes the quota), then the body streamed into the store, then the row `ready`. A
 * row already `ready` from the same headers answers 200 without reading the body (a retry).
 */
async function put(request: Request, env: AttachmentsEnv, p: Principal, sessionId: string, id: string, org: () => OrgRpc, out: Reply): Promise<Response> {
  const mimetype = mediaTypeOf(request.headers.get("content-type"));
  if (!mimetype) return out.error(400, "invalid_request", "content-type is the attachment's media type.", { field: "content-type" });
  const length = request.headers.get("content-length");
  if (length === null || !/^\d{1,15}$/.test(length.trim())) return out.error(400, "invalid_request", "content-length is the attachment's size in bytes.", { field: "content-length" });
  const bytes = Number(length);
  if (bytes > ATTACHMENT_BYTES_MAX) return out.error(413, "attachment_too_large", `An attachment is at most ${ATTACHMENT_BYTES_MAX} bytes.`, { max: ATTACHMENT_BYTES_MAX, bytes });
  const name = filenameOf(request.headers.get("content-disposition"));
  if (!name) return out.error(400, "invalid_request", "content-disposition carries the file's name (filename*=UTF-8''… or filename=\"…\"): 1 to 255 characters, no path separators.", { field: "content-disposition" });

  const made = await timedDo(out.facts, org().attachmentCreate(p, sessionId, id, { name, mimetype, bytes }));
  if (!made.ok) return refusalOf(out, made);
  if (!made.created) {
    out.facts.replayed = true;
    return out.send(200, { attachment: made.attachment });
  }
  const store = storeOf(env);
  if (!store) return out.error(503, "unavailable", "Attachments are not available on this deployment.", { retryAfterMs: RETRY_AFTER_MS });
  let etag: string;
  try {
    const body = request.body ?? new ReadableStream({ start: (c) => c.close() });
    etag = (await store.put(attachmentKey(p.org, sessionId, id), body, { bytes, contentType: mimetype })).etag;
  } catch (error) {
    // FixedLengthStream's refusal of a body of another length; anything else is the store.
    if (isLengthError(error)) return out.error(400, "content_mismatch", "The body is not content-length bytes long.", { field: "content-length" });
    return out.error(503, "unavailable", "The attachment could not be stored.", { retryAfterMs: RETRY_AFTER_MS });
  }
  const ready = await timedDo(out.facts, org().attachmentReady(id, etag));
  if (!ready.ok) return refusalOf(out, ready);
  return out.send(201, { attachment: ready.attachment });
}

const isLengthError = (error: unknown): boolean => error instanceof LengthMismatch || (error instanceof TypeError && /length|bytes|FixedLengthStream/i.test(String((error as Error).message)));

/**
 * `GET …/content`: the row (Org judges who may read), then the object streamed out with the row's
 * `content-type`, `nosniff`, `inline` for raster images only, and one `Range`.
 */
async function content(request: Request, env: AttachmentsEnv, p: Principal, sessionId: string, id: string, org: () => OrgRpc, out: Reply): Promise<Response> {
  const r = await timedDo(out.facts, org().attachmentRead(p, sessionId, id));
  if (!r.ok) return refusalOf(out, r);
  const a = r.attachment;
  if (a.state === "uploading") return out.error(409, "attachment_not_ready", "The attachment is still uploading.", { attachmentId: id });
  const store = storeOf(env);
  if (!store) return out.error(503, "unavailable", "Attachments are not available on this deployment.", { retryAfterMs: RETRY_AFTER_MS });

  const headers = contentHeaders(a);
  const range = rangeOf(request.headers.get("range"), a.bytes);
  if (range === "unsatisfiable") return out.stream(416, null, { ...headers, "content-range": `bytes */${a.bytes}` });
  if (a.etag && request.headers.get("if-none-match")?.split(",").some((t) => t.trim() === a.etag)) return out.stream(304, null, headers);

  let object;
  try {
    object = await store.get(attachmentKey(p.org, sessionId, id), range ?? undefined);
  } catch {
    return out.error(503, "unavailable", "The attachment could not be read.", { retryAfterMs: RETRY_AFTER_MS });
  }
  if (!object) return out.error(404, "attachment_not_found", "The attachment's content is not there.", { attachmentId: id });
  if (range) {
    return out.stream(206, object.body, { ...headers, "content-length": String(range.length), "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${object.bytes}` });
  }
  return out.stream(200, object.body, { ...headers, "content-length": String(object.bytes) });
}

function contentHeaders(a: Attachment): Record<string, string> {
  const disposition = INLINE_TYPES.has(a.mimetype) ? "inline" : "attachment";
  return {
    "content-type": a.mimetype,
    "content-disposition": `${disposition}; filename*=UTF-8''${encodedName(a.name)}`,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "accept-ranges": "bytes",
    ...(a.etag ? { etag: a.etag } : {}),
  };
}
