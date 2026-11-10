// Slack button ids for the prompts a runner posts (approvals, questions): the
// gateway decodes the click back to the session, the runner encodes it. Shared
// by both through protocol.ts (moved out of it in work 084 for its size).
// Session keys contain ':' (channel:ts), so they travel base64url-encoded.
// Format: p:<base64url(sessionKey)>:<promptId>:<value>. Slack allows 255 chars.

export function encodeActionId(sessionKey: string, promptId: string, value: string): string {
  return `p:${Buffer.from(sessionKey).toString('base64url')}:${promptId}:${value}`;
}

export function decodeActionId(actionId: string): { sessionKey: string; promptId: string; value: string } | undefined {
  const m = actionId.match(/^p:([A-Za-z0-9_-]+):([^:]+):(.*)$/);
  if (!m) return undefined;
  return { sessionKey: Buffer.from(m[1], 'base64url').toString(), promptId: m[2], value: m[3] };
}
