// The Slack actor with fakes of the three actors it calls. A fake keeps what it was told in
// memory; a test sets its answers and reads its calls over RPC.

import { DurableObject } from "cloudflare:workers";

import type { AcceptResult, MutateReply, Principal, SlackCarry } from "../../src/actor/contracts.js";

export { SlackDurableObject } from "../../src/slack/durable-object.js";

export type Call = { method: string; args: unknown[] };

class Recorder extends DurableObject {
  protected seen: Call[] = [];

  protected record(method: string, ...args: unknown[]): void {
    this.seen.push({ method, args: structuredClone(args) });
  }

  async calls(): Promise<Call[]> {
    return this.seen;
  }
}

export class FakeOrg extends Recorder {
  private readable = true;
  private mutateError: string | null = null;
  private owner = "slack:T1:U1";
  private writers: "members" | string[] = "members";

  async set(next: { readable?: boolean; mutateError?: string | null; owner?: string; writers?: "members" | string[] }): Promise<void> {
    if (next.readable !== undefined) this.readable = next.readable;
    if (next.mutateError !== undefined) this.mutateError = next.mutateError;
    if (next.owner !== undefined) this.owner = next.owner;
    if (next.writers !== undefined) this.writers = next.writers;
  }

  async createSession(p: Principal, body: { id?: string }) {
    this.record("createSession", p, body);
    const duplicate = this.seen.filter((c) => c.method === "createSession" && (c.args[1] as { id?: string }).id === body.id).length > 1;
    return { ok: true as const, session: { id: body.id } as never, place: null, duplicate };
  }

  async getSession(p: Principal, id: string) {
    this.record("getSession", p, id);
    return this.readable ? { ok: true as const, session: { id, owner: { id: this.owner, name: "", email: null } } as never } : { ok: false as const, code: "not_found", status: 404 };
  }

  async access(sessionId: string) {
    this.record("access", sessionId);
    return this.readable ? { owner: this.owner, audience: `member:${this.owner}`, writers: this.writers, agents: [], readers: [], machine: "org_a", revision: 1 } : null;
  }

  async mutate(p: Principal, m: unknown): Promise<MutateReply> {
    this.record("mutate", p, m);
    return this.mutateError ? { error: { code: this.mutateError as "refused" } } : { protocol: 1, version: 1 };
  }

  async linkPerson(from: string, to: string): Promise<void> {
    this.record("linkPerson", from, to);
  }
}

export class FakeSessionLog extends Recorder {
  private answer: AcceptResult | null = null;
  private delayMs = 0;
  private failures = 0;

  async set(next: { answer?: AcceptResult | null; delayMs?: number; failures?: number }): Promise<void> {
    if (next.answer !== undefined) this.answer = next.answer;
    if (next.delayMs !== undefined) this.delayMs = next.delayMs;
    if (next.failures !== undefined) this.failures = next.failures;
  }

  async accept(p: Principal, entry: { id: string; kind: string; body: unknown }): Promise<AcceptResult> {
    this.record("accept", p, entry);
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("the log could not be reached");
    }
    // The first call is slow: a later message that overtook it would be recorded first.
    if (this.delayMs && this.seen.length === 1) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.answer ?? { ok: true, id: entry.id, duplicate: false, machine: "org_a" };
  }
}

export class FakeComputer extends Recorder {
  private carry: SlackCarry = { settings: {}, people: [], links: [] };
  /** As the old team router (`computer-slack-team:<T>`): the organization it names. */
  private account: string | null = null;

  async set(next: { carry?: SlackCarry; teamAccount?: string }): Promise<void> {
    if (next.carry) this.carry = next.carry;
    if (next.teamAccount) this.account = next.teamAccount;
  }

  async teamAccount(): Promise<string | null> {
    return this.account;
  }

  async command(p: Principal, c: { name: string; args: string; sessionId?: string }): Promise<{ reply: string }> {
    this.record("command", p, c);
    return { reply: `did ${c.name}` };
  }

  async changed(source: string): Promise<void> {
    this.record("changed", source);
  }

  async interaction(p: Principal, c: { interaction: unknown; sessionId?: string }): Promise<{ errors?: Record<string, string> }> {
    this.record("interaction", p, c);
    const view = (c.interaction as { type?: string; view?: { state?: { values?: Record<string, unknown> } } }).view;
    return view && !Object.keys(view.state?.values ?? {}).length ? { errors: { value: "Enter a value" } } : {};
  }

  async memberLeft(slackUserId: string): Promise<void> {
    this.record("memberLeft", slackUserId);
  }

  async slackCarry(): Promise<SlackCarry> {
    this.record("slackCarry");
    return this.carry;
  }
}

export default {
  fetch(): Response {
    return new Response("Not found.", { status: 404 });
  },
};
