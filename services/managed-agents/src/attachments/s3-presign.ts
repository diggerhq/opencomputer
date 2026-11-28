// A presigned S3 URL (AWS Signature Version 4, query-string form): whoever holds it may do the one
// request it names until it expires, with no credential of ours. R2's S3 endpoint takes the same;
// so does any S3-compatible store. WebCrypto only, so it runs in a Worker and in node.
//
// The signed headers are part of the grant: a PUT signed with `content-type` and `content-length`
// is refused by the store when the request's own differ, which is what holds an upload to its
// declared size.

export interface S3Config {
  /** The store's S3 endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `auto` for R2. */
  region?: string;
}

export interface Presign {
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  key: string;
  expiresS: number;
  /** Headers the request must carry as given (lower-case names); `host` is added. */
  headers?: Record<string, string>;
  /** Query parameters signed with it (`response-content-type`, …). */
  query?: Record<string, string>;
  now?: number;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
/** RFC 3986 encoding, as SigV4 asks: everything but the unreserved characters. */
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

/** The object's URL in the bucket, path-style: `<endpoint>/<bucket>/<key>`, each segment encoded. */
export const objectUrl = (c: Pick<S3Config, "endpoint" | "bucket">, key: string): string =>
  `${c.endpoint.replace(/\/+$/, "")}/${rfc3986(c.bucket)}/${key.split("/").map(rfc3986).join("/")}`;

/** Signs `url` (no query of its own) for one request. */
export async function presignUrl(url: string, c: Pick<S3Config, "accessKeyId" | "secretAccessKey" | "region">, p: Omit<Presign, "key">): Promise<string> {
  const u = new URL(url);
  const region = c.region ?? "auto";
  const stamp = new Date(p.now ?? Date.now()).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = stamp.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const headers: Record<string, string> = { ...p.headers, host: u.host };
  const names = Object.keys(headers).sort();
  const query: Record<string, string> = {
    ...p.query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${c.accessKeyId}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(p.expiresS),
    "X-Amz-SignedHeaders": names.join(";"),
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(query[k]!)}`)
    .join("&");
  const canonical = [p.method, u.pathname, canonicalQuery, ...names.map((n) => `${n}:${headers[n]!.trim()}`), "", names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, hex(await crypto.subtle.digest("SHA-256", enc.encode(canonical)))].join("\n");
  let key = await hmac(enc.encode(`AWS4${c.secretAccessKey}`), day);
  for (const part of [region, "s3", "aws4_request"]) key = await hmac(key, part);
  return `${u.origin}${u.pathname}?${canonicalQuery}&X-Amz-Signature=${hex(await hmac(key, toSign))}`;
}

export const presign = (c: S3Config, p: Presign): Promise<string> => presignUrl(objectUrl(c, p.key), c, p);
