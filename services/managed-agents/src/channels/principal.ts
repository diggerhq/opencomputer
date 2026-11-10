export async function channelPrincipalId(
  provider: string,
  accountId: string,
  connectionId: string,
  externalUserId: string,
): Promise<string> {
  const input = `${provider}\0${accountId}\0${connectionId}\0${externalUserId}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  const identifier = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `channel:${provider}:${identifier}`;
}
