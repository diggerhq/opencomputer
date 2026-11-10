// Host tokens (work 052, decision 5). An organization's computer dials
// /v1/computer/host with a bearer token derived from its organization id, so
// one organization's computer cannot connect as another's. The key
// (COMPUTER_HOST_TOKEN_KEY) never leaves the edge Worker; the derived token
// reaches only that organization's VM, in its root-only customData.
//
// Unlike dash-cal there is no shared legacy token: no hand-made host ever
// connected to this gateway.

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** `sph_` + base64url(HMAC-SHA256(key, "calvin-host:" + organizationId)). */
export async function hostToken(key: string, organizationId: string): Promise<string> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(`calvin-host:${organizationId}`));
  return `sph_${base64Url(new Uint8Array(mac))}`;
}

/** Equal strings, in time independent of where they differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function bearerToken(request: Request): string | undefined {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
}

/** May this bearer token connect as the host of `organizationId`? Only its derived token. */
export async function hostAuthorized(
  token: string | undefined,
  organizationId: string | null,
  key: string | undefined,
): Promise<boolean> {
  if (!token || !organizationId || !key) return false;
  return constantTimeEqual(token, await hostToken(key, organizationId));
}
