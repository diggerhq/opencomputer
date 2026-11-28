// The object route of the bucket store (work 126, attachments/store.ts): where a
// deployment without an S3 endpoint (the self-host under Miniflare) takes and serves an
// attachment's bytes, as the store's own bucket does on hosted.
//
//   PUT     /v1/computer/attachment-objects/<org>/<session>/<id>?op=put&…&sig=…   the file, once
//   GET     /v1/computer/attachment-objects/<org>/<session>/<id>?op=get&…&sig=…   the bytes, one Range
//   HEAD    the same URL as GET
//   OPTIONS the preflight
//
// No credential is read: the URL's signature and expiry are the authority, as on a presigned S3
// URL, so any origin may call it (web and the Mac app both do). Everything the response says of
// the object (type, disposition) is what was signed, never what the uploader's request claimed.

import { LengthMismatch, OBJECT_ROUTE, putObject, verifyObjectUrl, type AttachmentsEnv, type ObjectGrant } from "../../attachments/store.js";

/** What api-edge sends with a call it forwards: the origin its caller reached it at. */
export const PUBLIC_ORIGIN_HEADER = "x-opencomputer-public-origin";

const CORS = { "access-control-allow-origin": "*" };
const PREFLIGHT = {
  ...CORS,
  "access-control-allow-methods": "GET, HEAD, PUT, OPTIONS",
  "access-control-allow-headers": "content-type, range",
  "access-control-max-age": "86400",
};
const EXPOSED = "accept-ranges, content-disposition, content-length, content-range, etag";

const refuse = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  Response.json({ error: { code, message } }, { status, headers: { ...CORS, "cache-control": "no-store", ...headers } });

/** The object route's answer, or null when the path is not it or this deployment has no bucket store. */
export async function routeAttachmentObject(request: Request, env: AttachmentsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${OBJECT_ROUTE}/`)) return null;
  const { ATTACHMENTS: bucket, ATTACHMENTS_URL_KEY: secret } = env;
  if (!bucket || !secret) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PREFLIGHT });
  if (request.method !== "PUT" && request.method !== "GET" && request.method !== "HEAD") return refuse(405, "method_not_allowed", "PUT, GET or HEAD.", { allow: "GET, HEAD, PUT, OPTIONS" });
  const grant = await verifyObjectUrl(secret, url);
  // 403, as a store answers an expired presigned URL: the uploader asks for a new one.
  if (!grant || grant.op !== (request.method === "PUT" ? "put" : "get")) return refuse(403, "forbidden", "The URL's signature is not valid or it has expired.");
  return request.method === "PUT" ? put(request, bucket, grant) : get(request, bucket, grant);
}

async function put(request: Request, bucket: R2Bucket, grant: ObjectGrant): Promise<Response> {
  const bytes = grant.bytes;
  if (bytes === undefined) return refuse(403, "forbidden", "The URL's signature is not valid or it has expired.");
  if ((request.headers.get("content-type") ?? "").trim().toLowerCase() !== grant.contentType) return refuse(400, "content_mismatch", "content-type is not the one the URL was signed for.");
  const mismatch = () => refuse(400, "content_mismatch", `The body must be exactly ${bytes} bytes.`);
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) !== bytes) return mismatch();
  try {
    const stored = await putObject(bucket, grant.key, request.body, { bytes, contentType: grant.contentType });
    return new Response(null, { status: 200, headers: { ...CORS, etag: stored.etag, "cache-control": "no-store" } });
  } catch (error) {
    // The runtime's fixed-length stream fails with its own TypeError.
    if (error instanceof LengthMismatch || error instanceof TypeError) return mismatch();
    throw error;
  }
}

/** One `Range` of an object `size` long: the range, `"whole"` when there is none to honour, `"unsatisfiable"` for 416. */
export function rangeOf(header: string | null, size: number): { offset: number; length: number } | "whole" | "unsatisfiable" {
  const m = header === null ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Another unit, a list of ranges or a malformed one: the whole object, as HTTP allows.
  if (!m || (m[1] === "" && m[2] === "")) return "whole";
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const first = Number(m[1]);
  const last = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (first >= size) return "unsatisfiable";
  if (last < first) return "whole";
  return { offset: first, length: last - first + 1 };
}

async function get(request: Request, bucket: R2Bucket, grant: ObjectGrant): Promise<Response> {
  const head = await bucket.head(grant.key);
  if (!head) return refuse(404, "attachment_not_found", "No such object.");
  const range = rangeOf(request.headers.get("range"), head.size);
  if (range === "unsatisfiable") return refuse(416, "range_not_satisfiable", "The range is outside the object.", { "content-range": `bytes */${head.size}`, "accept-ranges": "bytes" });
  const part = range === "whole" ? null : range;
  const headers = new Headers({
    ...CORS,
    "access-control-expose-headers": EXPOSED,
    "content-type": grant.contentType,
    ...(grant.disposition ? { "content-disposition": grant.disposition } : {}),
    "content-length": String(part ? part.length : head.size),
    ...(part ? { "content-range": `bytes ${part.offset}-${part.offset + part.length - 1}/${head.size}` } : {}),
    "accept-ranges": "bytes",
    etag: head.httpEtag,
    // An id's bytes never change, and the URL is one reader's.
    "cache-control": "private, max-age=31536000, immutable",
    // The bytes are an uploader's and this is our own origin: nothing in them runs here.
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  });
  const status = part ? 206 : 200;
  if (request.method === "HEAD") return new Response(null, { status, headers });
  const object = await bucket.get(grant.key, part ? { range: part } : undefined);
  if (!object) return refuse(404, "attachment_not_found", "No such object.");
  // The runtime frames a stream of known length; without it the body would go out chunked.
  const framed = fixedBody(object.body, part ? part.length : head.size);
  return new Response(framed, { status, headers });
}

function fixedBody(body: ReadableStream, bytes: number): ReadableStream {
  const Fixed = (globalThis as { FixedLengthStream?: new (bytes: number) => { readable: ReadableStream; writable: WritableStream } }).FixedLengthStream;
  if (!Fixed) return body;
  const fixed = new Fixed(bytes);
  void body.pipeTo(fixed.writable).catch(() => undefined);
  return fixed.readable;
}

/**
 * Where the caller of `request` reached this deployment, for URLs handed back to it. api-edge
 * calls us at an internal name and says where it was called (it copies only its own headers, so
 * the value is its own); a direct caller's URL says it itself. A caller that sends the header
 * itself only changes the URL in its own answer: the origin is not in the signature.
 */
export function callerOrigin(request: Request, env: { COMPUTER_PUBLIC_ORIGIN?: string }): string {
  const forwarded = originOf(request.headers.get(PUBLIC_ORIGIN_HEADER));
  if (forwarded) return forwarded;
  const url = new URL(request.url);
  // serve.mjs's name for this Worker inside the gateway (api-edge's MANAGED_AGENTS_API_URL): nobody outside resolves it.
  if (url.hostname.endsWith(".selfhost")) return originOf(env.COMPUTER_PUBLIC_ORIGIN ?? null) ?? url.origin;
  return url.origin;
}

/** An http(s) origin and nothing more, or null. */
function originOf(value: string | null): string | null {
  if (!value || !URL.canParse(value)) return null;
  const u = new URL(value);
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.pathname !== "/" || u.search || u.hash) return null;
  return u.origin;
}
