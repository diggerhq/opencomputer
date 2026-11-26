// Delivery with fakes of the three actors it calls. A fake keeps what it was told in memory; a
// test sets its answers and reads its calls over RPC.

import { DurableObject } from "cloudflare:workers";

import type { Occurrence, Principal, SlackEcho } from "../../src/actor/contracts.js";

export { DeliveryDurableObject } from "../../src/delivery/durable-object.js";

export type FakeOccurrence = Omit<Occurrence, "n"> & { n: number };

export class FakeOrg extends DurableObject {
  private entries: FakeOccurrence[] = [];
  private targets: Record<number, string[]> = {};
  private echoes: Record<number, SlackEcho | null> = {};
  private reads: { subject: string; after: string | undefined }[] = [];

  async add(entries: FakeOccurrence[], targets: Record<number, string[]> = {}, echoes: Record<number, SlackEcho | null> = {}): Promise<number> {
    this.entries.push(...entries);
    Object.assign(this.targets, targets);
    Object.assign(this.echoes, echoes);
    return this.entries.at(-1)?.n ?? 0;
  }

  async occurrences(p: Principal, q: { after?: string; limit?: number }): Promise<{ entries: Occurrence[]; to: string }> {
    this.reads.push({ subject: p.subject, after: q.after });
    const after = q.after ? Number(q.after.slice(3)) : 0;
    const page = this.entries.filter((entry) => entry.n > after).slice(0, q.limit ?? 100);
    const to = page.at(-1)?.n ?? after;
    return { entries: page.map(({ n, ...entry }) => ({ ...entry, n: `o1.${n}` })), to: `o1.${to}` };
  }

  async wakeTargets(n: number): Promise<string[]> {
    return this.targets[n] ?? [];
  }

  async digest(target: string, fromN: number, toN: number): Promise<string> {
    return `digest for ${target}: ${fromN} to ${toN}`;
  }

  async echo(n: number): Promise<SlackEcho | null> {
    return this.echoes[n] ?? null;
  }

  async calls(): Promise<{ subject: string; after: string | undefined }[]> {
    return this.reads;
  }
}

export class FakeSessionLog extends DurableObject {
  private accepted: { by: string; entry: unknown }[] = [];
  private full = 0;

  async refuse(times: number): Promise<void> {
    this.full = times;
  }

  async accept(p: Principal, entry: { id: string }): Promise<{ ok: true; id: string; duplicate: boolean; machine: string } | { ok: false; code: "inbox_full" }> {
    if (this.full > 0) {
      this.full -= 1;
      return { ok: false, code: "inbox_full" };
    }
    const duplicate = this.accepted.some((a) => (a.entry as { id: string }).id === entry.id);
    if (!duplicate) this.accepted.push({ by: p.kind, entry });
    return { ok: true, id: entry.id, duplicate, machine: "m" };
  }

  async calls(): Promise<{ by: string; entry: unknown }[]> {
    return this.accepted;
  }
}

export class FakeSlack extends DurableObject {
  private notified: SlackEcho[] = [];

  async notify(e: SlackEcho): Promise<void> {
    this.notified.push(e);
  }

  async calls(): Promise<SlackEcho[]> {
    return this.notified;
  }
}

export default {
  fetch(): Response {
    return new Response("Not found.", { status: 404 });
  },
};
