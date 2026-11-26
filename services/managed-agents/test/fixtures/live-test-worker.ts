// Live with fakes of the two actors it calls. A fake keeps what it was told in memory; a test
// sets its answers and reads its calls over RPC.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import type { LiveCredentials, Principal } from "../../src/actors/live/contract.js";

export { LiveDurableObject } from "../../src/actors/live/durable-object.js";

export class FakeSessionLog extends DurableObject {
  private head = "e1.1.0";
  private allowed = true;
  private machine: string | undefined;
  private watches: { subject: string; until: number }[] = [];
  /** Set by `set({ hold: true })`: watches wait for `release()` before they answer. */
  private held: Promise<void> | null = null;
  private release_: (() => void) | null = null;

  async set(next: { head?: string; allowed?: boolean; machine?: string; hold?: boolean }): Promise<void> {
    if (next.head !== undefined) this.head = next.head;
    if (next.allowed !== undefined) this.allowed = next.allowed;
    if (next.machine !== undefined) this.machine = next.machine;
    if (next.hold) this.held = new Promise((resolve) => (this.release_ = resolve));
  }

  async release(): Promise<void> {
    this.release_?.();
    this.held = null;
    this.release_ = null;
  }

  async watch(p: Principal, until: number): Promise<{ head: string; machine?: string } | null> {
    this.watches.push({ subject: p.subject, until });
    if (this.held) await this.held;
    if (!this.allowed) return null;
    return { head: this.head, ...(this.machine ? { machine: this.machine } : {}) };
  }

  async calls(): Promise<{ subject: string; until: number }[]> {
    return this.watches;
  }
}

export class FakeComputer extends DurableObject {
  private seen: { call: "watch" | "block"; sessionId: string; blockId?: string }[] = [];

  async watch(sessionId: string): Promise<void> {
    this.seen.push({ call: "watch", sessionId });
  }

  async block(sessionId: string, blockId: string): Promise<void> {
    this.seen.push({ call: "block", sessionId, blockId });
  }

  async calls(): Promise<{ call: "watch" | "block"; sessionId: string; blockId?: string }[]> {
    return this.seen;
  }
}

/**
 * api-edge's `LiveCredentials` entrypoint, faked: the credential `cred_revoked` is revoked, the
 * token `renewed` verifies as the same principal with a later expiry, `other` as another subject.
 */
export class FakeEdge extends WorkerEntrypoint implements LiveCredentials {
  async revoked(ids: string[]): Promise<string[]> {
    return ids.filter((id) => id === "cred_revoked");
  }

  async principal(token: string): Promise<Principal | null> {
    const principal = (subject: string): Principal => ({
      org: "org_a",
      subject,
      kind: "member",
      via: "app",
      scopes: ["sessions:read", "work:read"],
      audiences: ["org"],
      admin: false,
      credential: { id: "cred_renewed", expiresAt: null },
    });
    if (token === "renewed") return principal("user_1");
    if (token === "other") return principal("user_2");
    return null;
  }
}

export default {
  fetch(): Response {
    return new Response("Not found.", { status: 404 });
  },
};
