// The object store of attachments (work 126, section 5): the bytes, keyed `<org>/<session>/<id>`,
// beside Org's rows. No code of ours carries an attachment's bytes: the store hands out signed
// URLs (s3-presign.ts), the uploader sends the file to one and a reader fetches it from one.
//
// Two stores, one client contract. `s3Attachments` is anything that speaks S3 (R2 in production,
// S3 or MinIO where an operator configures one): the endpoint and a key pair are all it takes.
// `bucketAttachments` is for a deployment with an R2 binding and no S3 endpoint (the self-host
// under Miniflare): its URLs are our own object route (http/api/attachment-objects.ts), signed by
// us, and that route streams the bytes to and from the binding.

import { objectUrl, presign, presignUrl, type S3Config } from "./s3-presign.js";

export interface Attachments {
  /** A URL that takes one `PUT` of exactly `bytes` bytes with this `content-type`, until it expires. */
  uploadUrl(key: string, meta: { bytes: number; contentType: string }, expiresS: number): Promise<{ url: string; headers: Record<string, string> }>;
  /** A URL that serves the object with these headers, until it expires. */
  downloadUrl(key: string, as: { contentType: string; disposition: string }, expiresS: number): Promise<string>;
  /** The stored object's size and etag, or null when there is none. */
  head(key: string): Promise<{ bytes: number; etag: string } | null>;
  delete(key: string): Promise<void>;
  /** Delete every object under the prefix. */
  removeAll(prefix: string): Promise<void>;
}

/** What configures the store: the four S3 values, or else the binding and its URL key; without either there are no attachments. */
export interface AttachmentsEnv {
  ATTACHMENTS_S3_ENDPOINT?: string;
  ATTACHMENTS_S3_BUCKET?: string;
  ATTACHMENTS_S3_ACCESS_KEY_ID?: string;
  ATTACHMENTS_S3_SECRET_ACCESS_KEY?: string;
  /** Default `auto` (R2). */
  ATTACHMENTS_S3_REGION?: string;
  /** The bucket of a deployment without an S3 endpoint (the self-host). */
  ATTACHMENTS?: R2Bucket;
  /** Signs the bucket store's URLs (HMAC-SHA256). */
  ATTACHMENTS_URL_KEY?: string;
}

export function configOf(env: AttachmentsEnv): S3Config | null {
  const { ATTACHMENTS_S3_ENDPOINT: endpoint, ATTACHMENTS_S3_BUCKET: bucket, ATTACHMENTS_S3_ACCESS_KEY_ID: accessKeyId, ATTACHMENTS_S3_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey, ...(env.ATTACHMENTS_S3_REGION ? { region: env.ATTACHMENTS_S3_REGION } : {}) };
}

/**
 * The store of an env, or null where it is not configured: S3 when its four values are set, else
 * the bucket when it and its key are bound. `origin` is where the caller reached us, for the
 * bucket store's URLs; one that only deletes (Org) or asks whether there is a store needs none.
 */
export const attachmentsOf = (env: AttachmentsEnv, origin?: string): Attachments | null => {
  const config = configOf(env);
  if (config) return s3Attachments(config);
  if (!env.ATTACHMENTS || !env.ATTACHMENTS_URL_KEY) return null;
  return bucketAttachments(env.ATTACHMENTS, { key: env.ATTACHMENTS_URL_KEY, ...(origin ? { origin } : {}) });
};

/** Our own requests are signed the same way and live a minute. */
const OWN_S = 60;

export function s3Attachments(c: S3Config): Attachments {
  const own = async (method: "HEAD" | "DELETE", key: string) => fetch(await presign(c, { method, key, expiresS: OWN_S }), { method });
  const failed = (what: string, r: Response) => new Error(`attachments store: ${what} answered ${r.status}`);
  return {
    uploadUrl: async (key, meta, expiresS) => {
      const headers = { "content-type": meta.contentType };
      // `content-length` is signed too: the uploader's client sets it from the body, and the store refuses another.
      return { url: await presign(c, { method: "PUT", key, expiresS, headers: { ...headers, "content-length": String(meta.bytes) } }), headers };
    },
    downloadUrl: (key, as, expiresS) =>
      presign(c, { method: "GET", key, expiresS, query: { "response-content-type": as.contentType, "response-content-disposition": as.disposition, "response-cache-control": "private, max-age=31536000, immutable" } }),
    head: async (key) => {
      const r = await own("HEAD", key);
      if (r.status === 404) return null;
      if (!r.ok) throw failed("HEAD", r);
      return { bytes: Number(r.headers.get("content-length")), etag: r.headers.get("etag") ?? "" };
    },
    delete: async (key) => {
      const r = await own("DELETE", key);
      if (!r.ok && r.status !== 404) throw failed("DELETE", r);
    },
    removeAll: async (prefix) => {
      for (let token: string | undefined; ; ) {
        const url = await presignUrl(objectUrl(c, "").replace(/\/$/, ""), c, { method: "GET", expiresS: OWN_S, query: { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) } });
        const r = await fetch(url);
        if (!r.ok) throw failed("list", r);
        const xml = await r.text();
        for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
          const d = await own("DELETE", unxml(m[1]!));
          if (!d.ok && d.status !== 404) throw failed("DELETE", d);
        }
        token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
        if (!token) return;
        token = unxml(token);
      }
    },
  };
}

const unxml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[e]!);

// ------------------------------------------------------------------ the bucket store

/** Where the bucket store's URLs point: `<origin>/v1/computer/attachment-objects/<org>/<session>/<id>`. */
export const OBJECT_ROUTE = "/v1/computer/attachment-objects";

/** What one signed URL grants. The origin is not part of it: one deployment is reached by more than one. */
export interface ObjectGrant {
  op: "put" | "get";
  key: string;
  /** Unix seconds. */
  exp: number;
  /** A put's exact size. */
  bytes?: number;
  contentType: string;
  /** A get's `content-disposition`. */
  disposition?: string;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const hmacKey = (secret: string) => crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
// JSON, so no field's content can pass for another's.
const signedText = (g: ObjectGrant) => enc.encode(JSON.stringify(["attachment-object.v1", g.op, g.key, g.exp, g.bytes ?? null, g.contentType, g.disposition ?? null]));

/** The grant as a URL's path and query, signed. */
export async function signObjectPath(secret: string, g: ObjectGrant): Promise<string> {
  const q = new URLSearchParams({ op: g.op, exp: String(g.exp), type: g.contentType });
  if (g.bytes !== undefined) q.set("bytes", String(g.bytes));
  if (g.disposition !== undefined) q.set("disposition", g.disposition);
  q.set("sig", hex(await crypto.subtle.sign("HMAC", await hmacKey(secret), signedText(g))));
  return `${OBJECT_ROUTE}/${g.key.split("/").map(encodeURIComponent).join("/")}?${q}`;
}

/** The grant a URL carries, when its signature is ours and it has not expired; null otherwise. */
export async function verifyObjectUrl(secret: string, url: URL, now = Date.now()): Promise<ObjectGrant | null> {
  if (!url.pathname.startsWith(`${OBJECT_ROUTE}/`)) return null;
  const q = url.searchParams;
  const [op, exp, contentType, sig] = [q.get("op"), Number(q.get("exp")), q.get("type"), q.get("sig") ?? ""];
  if ((op !== "put" && op !== "get") || !Number.isSafeInteger(exp) || contentType === null || !/^[0-9a-f]{64}$/.test(sig)) return null;
  let key: string;
  try {
    key = url.pathname.slice(OBJECT_ROUTE.length + 1).split("/").map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
  const bytes = q.has("bytes") ? Number(q.get("bytes")) : undefined;
  if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 0)) return null;
  const disposition = q.get("disposition") ?? undefined;
  const grant: ObjectGrant = { op, key, exp, contentType, ...(bytes !== undefined ? { bytes } : {}), ...(disposition !== undefined ? { disposition } : {}) };
  const signature = Uint8Array.from(sig.match(/../g)!, (h) => parseInt(h, 16));
  // `verify` compares in constant time.
  if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), signature, signedText(grant)))) return null;
  return exp * 1000 > now ? grant : null;
}

/** A body-of-another-length failure: the object route answers it 400. */
export class LengthMismatch extends TypeError {
  constructor(expected: number, seen: number, more: boolean) {
    super(`The body is ${more ? "longer" : `${seen} bytes, not ${expected}`}; expected ${expected} bytes.`);
    this.name = "LengthMismatch";
  }
}

/**
 * A stream that is exactly `bytes` long, failing one that is shorter or longer. The Workers runtime's
 * `FixedLengthStream` (which R2 also needs to know a streamed body's length); a counting transform
 * elsewhere (node tests).
 */
export function fixedLength(bytes: number): { readable: ReadableStream; writable: WritableStream } {
  const Fixed = (globalThis as { FixedLengthStream?: new (bytes: number) => { readable: ReadableStream; writable: WritableStream } }).FixedLengthStream;
  if (Fixed) return new Fixed(bytes);
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > bytes) throw new LengthMismatch(bytes, seen, true);
      controller.enqueue(chunk);
    },
    flush() {
      if (seen !== bytes) throw new LengthMismatch(bytes, seen, false);
    },
  });
}

/** Stores `body`, declared `bytes` long, in the bucket. A body of another length fails and nothing is stored. */
export async function putObject(bucket: R2Bucket, key: string, body: ReadableStream | null, meta: { bytes: number; contentType: string }): Promise<{ etag: string }> {
  const httpMetadata = { contentType: meta.contentType };
  if (!body) {
    if (meta.bytes !== 0) throw new LengthMismatch(meta.bytes, 0, false);
    return { etag: (await bucket.put(key, new Uint8Array(0), { httpMetadata })).httpEtag };
  }
  // R2 needs a known length for a streamed body; the fixed-length stream also fails a body that is shorter or longer.
  const fixed = fixedLength(meta.bytes);
  let lengthError: unknown;
  const piping = body.pipeTo(fixed.writable).catch((error: unknown) => {
    lengthError = error;
    throw error;
  });
  try {
    const object = await bucket.put(key, fixed.readable, { httpMetadata });
    await piping;
    return { etag: object.httpEtag };
  } catch (error) {
    // The store failed before it drained the body: let the pipe go, or it waits for a reader forever.
    await fixed.readable.cancel(error).catch(() => undefined);
    await piping.catch(() => undefined);
    // The pipe's own failure (a body of another length) is the one to tell, not the store's reading of it.
    throw lengthError ?? error;
  }
}

/**
 * The store over an R2 binding. Its URLs are the object route on `origin`, each signed with `key`
 * for one grant; without an origin it still reads and deletes, and only cannot make a URL.
 */
export function bucketAttachments(bucket: R2Bucket, opts: { key: string; origin?: string }): Attachments {
  const url = async (g: ObjectGrant) => {
    if (!opts.origin) throw new Error("attachments store: a URL needs the origin its caller reached us at");
    return `${opts.origin.replace(/\/+$/, "")}${await signObjectPath(opts.key, g)}`;
  };
  const exp = (expiresS: number) => Math.floor(Date.now() / 1000) + expiresS;
  return {
    uploadUrl: async (key, meta, expiresS) => ({
      url: await url({ op: "put", key, exp: exp(expiresS), bytes: meta.bytes, contentType: meta.contentType }),
      headers: { "content-type": meta.contentType },
    }),
    downloadUrl: (key, as, expiresS) => url({ op: "get", key, exp: exp(expiresS), contentType: as.contentType, disposition: as.disposition }),
    head: async (key) => {
      const object = await bucket.head(key);
      return object ? { bytes: object.size, etag: object.httpEtag } : null;
    },
    delete: (key) => bucket.delete(key),
    removeAll: async (prefix) => {
      for (let cursor: string | undefined; ; ) {
        const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
        if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
        if (!page.truncated) return;
        cursor = page.cursor;
      }
    },
  };
}

/** The key of one attachment's object. */
export const attachmentKey = (org: string, sessionId: string, id: string): string => `${org}/${sessionId}/${id}`;
/** The prefix of a session's objects. */
export const attachmentPrefix = (org: string, sessionId: string): string => `${org}/${sessionId}/`;
