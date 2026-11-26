// The managed-agents Worker with Live beside it, as one script, for tests that run the whole
// stack on a local port (test/fixtures/stack.mjs). In production Live is its own Worker and the
// credential check is api-edge's; here the check accepts nothing beyond the socket's own principal.

import { WorkerEntrypoint } from "cloudflare:workers";

import type { LiveCredentials, Principal } from "../../src/actors/live/contract.js";

export * from "../../src/edge/index.js";
export { default } from "../../src/edge/index.js";
export { LiveDurableObject } from "../../src/actors/live/durable-object.js";

/** api-edge's `LiveCredentials`: no credential is revoked, and no `auth` token renews. */
export class StackCredentials extends WorkerEntrypoint implements LiveCredentials {
  async revoked(): Promise<string[]> {
    return [];
  }

  async principal(): Promise<Principal | null> {
    return null;
  }
}
