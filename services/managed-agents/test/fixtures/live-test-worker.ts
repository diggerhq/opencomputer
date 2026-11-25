// Live with fakes of the two actors it calls. A fake keeps what it was told in memory; a test
// sets its answers and reads its calls over RPC.

import { DurableObject } from "cloudflare:workers";

import type { Principal } from "../../src/live/contract.js";

export { LiveDurableObject } from "../../src/live/durable-object.js";

export class FakeSessionLog extends DurableObject {
  private head = "e1.1.0";
  private allowed = true;
  private machine: string | undefined;
  private watches: { subject: string; until: number }[] = [];

  async set(next: { head?: string; allowed?: boolean; machine?: string }): Promise<void> {
    if (next.head !== undefined) this.head = next.head;
    if (next.allowed !== undefined) this.allowed = next.allowed;
    if (next.machine !== undefined) this.machine = next.machine;
  }

  async watch(p: Principal, until: number): Promise<{ head: string; machine?: string } | null> {
    this.watches.push({ subject: p.subject, until });
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

export default {
  fetch(): Response {
    return new Response("Not found.", { status: 404 });
  },
};
