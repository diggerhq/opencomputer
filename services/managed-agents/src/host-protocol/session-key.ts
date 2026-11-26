// Slack session keys and prompt-button action ids.

import { base64url } from "../encoding/base64url.js";

/** `team:channel:threadTs`, as dash-cal keys its runners. */
/** A computer session's id in the managed-agent session index: unique beside serverless agent session ids. */
export function computerSessionId(key: string): string {
  return `computer:${key}`;
}

export function sessionKey(teamId: string, channelId: string, threadTs: string): string {
  return `${teamId}:${channelId}:${threadTs}`;
}

export function parseSessionKey(key: string): { teamId: string; channelId: string; threadTs: string } | null {
  const [teamId, channelId, threadTs, extra] = key.split(":");
  if (!teamId || !channelId || !threadTs || extra !== undefined) return null;
  return { teamId, channelId, threadTs };
}

/** A prompt button the runner posted: `p:<base64url(sessionKey)>:<promptId>:<value>`. */
export function decodeCalvinActionId(actionId: string): { sessionKey: string; promptId: string; value: string } | null {
  const match = actionId.match(/^p:([A-Za-z0-9_-]+):([^:]+):(.*)$/);
  if (!match?.[1] || !match[2] || match[3] === undefined) return null;
  const sessionKey = base64url.text(match[1]);
  return sessionKey === null ? null : { sessionKey, promptId: match[2], value: match[3] };
}
