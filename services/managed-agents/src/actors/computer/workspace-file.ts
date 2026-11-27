// One file of a session's workspace, read for a person signed in to the dashboard (a sent
// file's result, `GET /work/results/{id}/file`). The wire Worker serves the same route to API
// keys only; this signs the relay's X-Wire-* headers the way it does (wire/auth.ts), for the
// person, from the Computer object that holds the tunnel id and the platform key.
//
// Invariants:
// - The scope is read-only, `sessions:read`, and this one session: the relay still checks
//   the person may attach to it (computer/src/api/session-access.ts), so signing grants
//   nothing the person could not read with a key of their own.
// - The key id is `dashboard`: the relay's `/files` route does not look it up, and no key
//   by that name exists to revoke.
// - The relay's content type is not trusted where the dashboard serves it: only the image
//   types a browser shows inline go back as they came; everything else is text or a download.

import { computerKey, signWireAuth, WIRE_SIGNATURE_TTL_MS } from "../../wire/auth.js";

/** Types served as they are; any other is sent as a download (or plain text). */
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT = /^(text\/|application\/(json|x-ndjson|yaml|x-yaml|xml)\b)/;

export interface WorkspaceFileTarget {
  platformKey: string;
  tunnelId: string;
  tunnelDomain: string;
}

/** The relay's answer for `path` of `sessionId`, read as `member`; `ifNoneMatch` passes through. */
export async function workspaceFile(
  t: WorkspaceFileTarget,
  q: { member: string; sessionId: string; path: string; ifNoneMatch?: string | null },
  upstream: typeof fetch = fetch,
): Promise<Response> {
  const headers = await signWireAuth(await computerKey(t.platformKey, t.tunnelId), {
    member: q.member,
    keyId: "dashboard",
    client: "dashboard",
    scope: { scopes: ["sessions:read"], sessionIds: [q.sessionId], readOnly: true },
    exp: Date.now() + WIRE_SIGNATURE_TTL_MS,
  });
  if (q.ifNoneMatch) headers["if-none-match"] = q.ifNoneMatch;
  const url = `https://${t.tunnelId}.${t.tunnelDomain}/files/${q.sessionId}/file?${new URLSearchParams({ path: q.path })}`;
  return safeFile(await upstream(url, { headers }));
}

/** The relay's response with headers fit to serve from the dashboard's origin. */
export function safeFile(r: Response): Response {
  if (!r.ok) return r;
  const type = (r.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const headers = new Headers({ "x-content-type-options": "nosniff", "cache-control": "private, no-cache" });
  const etag = r.headers.get("etag");
  if (etag) headers.set("etag", etag);
  const length = r.headers.get("content-length");
  if (length) headers.set("content-length", length);
  if (INLINE.has(type)) headers.set("content-type", type);
  else if (TEXT.test(type)) headers.set("content-type", "text/plain; charset=utf-8");
  else {
    headers.set("content-type", "application/octet-stream");
    headers.set("content-disposition", "attachment");
  }
  // A sandbox for anything the browser may still render (it opens the URL itself, not as a blob).
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  return new Response(r.body, { status: r.status, headers });
}
