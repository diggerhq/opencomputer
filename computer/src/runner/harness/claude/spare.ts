// A spare runner's parked Claude Code (work 069): started before any session
// is known, with the Claude credential the host gave it, and handed over
// whole to the session that claims the runner.
//
// Invariants: at most one process is parked, and it was started with the
// credential `credential` names (its fingerprint): Claude Code copies the
// environment when it starts, so a new credential means close and start
// again. A parked process that goes away, or never starts, is reported as
// `died`: the runner exits and the host starts another spare. Taken or
// closed, a process is no longer this holder's to report.

import type { SpareProcess } from '@anthropic-ai/claude-agent-sdk';

export interface SpareEvents {
  /** Parked, or (re)starting: the host's view of this runner changed. */
  changed(): void;
  /** The parked process ended, or failed to start. */
  died(why: string): void;
}

export class Spare {
  private p?: SpareProcess;
  private fp?: string;
  /** Bumped by every start, take and close: a start that finishes late is closed, not parked. */
  private gen = 0;

  constructor(
    private start: () => Promise<SpareProcess>,
    private on: SpareEvents,
  ) {}

  /** Parked and claimable. */
  get ready() {
    return !!this.p;
  }

  /** The fingerprint of the credential the process was (or is being) started with. */
  get credential() {
    return this.fp;
  }

  /** Park a process started with the credential now in the environment; a different credential replaces it. */
  warm(credential: string) {
    if (credential === this.fp) return;
    this.close();
    this.fp = credential;
    const gen = this.gen;
    this.on.changed();
    this.start().then(
      (p) => {
        if (gen !== this.gen) return p.close();
        this.p = p;
        this.on.changed();
        void p.exited.then(() => this.p === p && ((this.p = undefined), this.on.died('exited while parked')));
      },
      (e) => gen === this.gen && this.on.died(String(e?.message ?? e)),
    );
  }

  /** Hand the parked process over, once; undefined when none is parked. */
  take(): SpareProcess | undefined {
    const p = this.p;
    this.p = undefined;
    this.gen++;
    return p;
  }

  close() {
    this.gen++;
    this.p?.close();
    this.p = undefined;
  }
}
