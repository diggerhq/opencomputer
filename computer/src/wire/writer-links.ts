// How one connection reaches session writers: `WriterLinks`, the call-only
// links to the writers of the sessions its client calls (the wire carries no
// session events: clients watch sessions through the cloud, work 118).
//
// Invariants: a call never goes to a link known to be closed; a cached link
// is dropped when its socket closes or the host says the writer moved; at
// most `callLinks` are kept, the least recently used closed first.

import type { WhereResult } from '../protocol.js';
import type { CallOutcome } from '../api/writer.js';
import { LIMITS } from './limits.js';
import type { HostLink } from './host-link.js';
import { errors } from './rpc.js';
import type { DialWriter, WriterLink } from './writer-client.js';

async function where(host: HostLink, sessionId: string): Promise<{ where: WhereResult } | { error: CallOutcome['error'] & object }> {
  const r = await host.call({ t: 'where', sessionId });
  if (r.error) return { error: r.error };
  return { where: r.result as WhereResult };
}

/** Call-only links to session writers, most recent `callLinks` kept. */
export class WriterLinks {
  private links = new Map<string, Promise<WriterLink | undefined>>();

  constructor(
    private host: HostLink,
    private dial: DialWriter,
  ) {}

  async get(sessionId: string): Promise<WriterLink | { error: NonNullable<CallOutcome['error']> }> {
    const cached = this.links.get(sessionId);
    if (cached) {
      const link = await cached;
      if (link && !link.closed) {
        this.links.delete(sessionId);
        this.links.set(sessionId, cached);
        return link;
      }
      this.links.delete(sessionId);
    }
    const w = await where(this.host, sessionId);
    if ('error' in w) return { error: w.error };
    const p = this.dial(w.where, {
      onClose: () => {
        if (this.links.get(sessionId) === p) this.links.delete(sessionId);
      },
    }).catch(() => undefined);
    this.links.set(sessionId, p);
    while (this.links.size > LIMITS.callLinks) {
      const [oldest, op] = this.links.entries().next().value as [string, Promise<WriterLink | undefined>];
      this.links.delete(oldest);
      void op.then((l) => l?.close());
    }
    const link = await p;
    return link ?? { error: errors.unavailable() };
  }

  /** The session's writer moved: the next call asks `where` again. */
  forget(sessionId: string) {
    const p = this.links.get(sessionId);
    this.links.delete(sessionId);
    void p?.then((l) => l?.close());
  }

  close() {
    for (const p of this.links.values()) void p.then((l) => l?.close());
    this.links.clear();
  }
}
