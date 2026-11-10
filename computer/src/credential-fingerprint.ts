// Which Claude credential a process runs with, as a short fingerprint both
// the host and a spare runner compute (work 069): a spare may serve a
// delivery only if it was started with the delivery's credential, since its
// Claude Code copied the environment when it started.
//
// A ChatGPT subscription's fingerprint (work 082) names the owner and the
// account instead: its access token is refreshed every few days, and a
// refresh must look like the same credential so the proxy swaps the token in
// place. The gateway (blue's model-subscriptions.ts) computes it the same way.
//
// Invariant: one-way and short; never the credential itself, so it may be
// logged and sent over the socket.

import { createHash } from 'node:crypto';
import type { HostCredentials } from './protocol.js';

/** The fingerprint of `c`'s Claude credential; undefined when it carries none. */
export function credentialFingerprint(c: Pick<HostCredentials, 'claudeOAuthToken' | 'anthropicApiKey' | 'anthropicBaseUrl'> | undefined) {
  if (!c?.claudeOAuthToken && !c?.anthropicApiKey) return undefined;
  const parts = c.claudeOAuthToken ? ['oauth', c.claudeOAuthToken] : ['key', c.anthropicApiKey ?? '', c.anthropicBaseUrl ?? ''];
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/** A ChatGPT route's fingerprint: sha256(`chatgpt\0owner\0accountId`), 12 hex, as the gateway computes it. Not the token. */
export function subscriptionFingerprint(owner: string, provider: 'chatgpt', accountId: string) {
  return createHash('sha256').update(`${provider}\0${owner}\0${accountId}`).digest('hex').slice(0, 12);
}
