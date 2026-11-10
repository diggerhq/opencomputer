// The tool-call timeline of a turn: each step (tool call, thinking) is a Task,
// consecutive steps share one card (a "run"), and text between them starts a
// new run. The Timeline owns the tasks and the current run and writes the
// run's card into the live Segment; the pure functions below decide what the
// card says.
//
// A turn addressed to the agent opens its message at push, before the model
// says anything (work 068 2b): the first run starts with no steps and a
// `Started` card. Slack replaces a card's title and status in place, so that
// card becomes the first step shown (a thinking block or a visible tool).
// Text first, it completes as `✓ Started`; a turn that fails first, as an
// error with the reason. It never claims a thinking block that wasn't there.

import { randomUUID } from 'node:crypto';
import { log } from '../log.js';
import { fmtDuration } from './format.js';
import type { Segment, Task } from './segment.js';

export const DETAILS_MAX = 250;
/** Cards per message before a long turn folds into its history (session.ts). */
export const FOLD_AT = Number(process.env.FOLD_AT ?? 4);

export interface Run {
  id: string;
  steps: string[];
  closed: boolean;
  /** Opened at push with a `Started` card (`open`): a run with no steps that is waiting for its first, not one left empty. */
  opening?: boolean;
  /** Closed while a step still ran: its card is written once more, when the turn ends. */
  seg?: Segment;
}

/** The opening card's title (`open`). */
export const OPENING = 'Started';

export const isThinking = (t: Task) => t.id.startsWith('think-');
const shortName = (t: Task) => t.name ?? t.title.replace(/\(.*$/s, '').replace(/…$/, '');
const mark = (t: Task) => (t.status === 'error' ? '✗' : '✓');

/** `✓ Read · ✓ Bash ×3 · ✗ Bash`: consecutive repeats merged. */
export function compact(steps: Task[]): string[] {
  const out: { label: string; n: number }[] = [];
  for (const s of steps) {
    const label = `${mark(s)} ${shortName(s)}`;
    const last = out.at(-1);
    if (last?.label === label) last.n++;
    else out.push({ label, n: 1 });
  }
  return out.map((x) => (x.n > 1 ? `${x.label} ×${x.n}` : x.label));
}

/** Join items into `budget` chars, dropping from the front when they don't fit. */
export function fitTail(items: string[], budget: number, sep = ' · ') {
  const out: string[] = [];
  let len = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const add = items[i].length + (out.length ? sep.length : 0);
    if (len + add > budget - 2) return ['…', ...out].join(sep);
    out.unshift(items[i]);
    len += add;
  }
  return out.join(sep);
}

/**
 * One card for a run of steps. While live: the latest step is the card (title,
 * timer, output), earlier steps fold into one line of details. Once closed:
 * "Ran N steps" with every step listed; a single step stays as itself. A
 * closed run is an error only if a step was interrupted: text or the end of
 * the turn followed every other failure, so the agent moved past it (a grep
 * with no match, a retried edit), and Slack's error badge would read as a
 * problem still going on. The failure still shows in the title.
 */
export function rollup(id: string, steps: Task[], closed: boolean): Task {
  const tools = steps.filter((s) => !isThinking(s));
  const running = steps.filter((s) => s.status === 'in_progress');
  if (!closed || running.length) {
    const cur = running.at(-1) ?? steps.at(-1)!;
    const earlier = tools.filter((s) => s !== cur && s.status !== 'in_progress');
    const others = running.length - (cur.status === 'in_progress' ? 1 : 0);
    const own = [cur.details, cur.elapsed].filter(Boolean).join(' · ');
    const extra = [others ? `+${others} running` : ''].filter(Boolean);
    const budget = DETAILS_MAX - own.length - 3 - extra.join(' · ').length - 14;
    const summary = earlier.length ? `${earlier.length} earlier: ${fitTail(compact(earlier), budget)}` : '';
    const details = [own, ...extra, summary].filter(Boolean).join(' · ');
    return {
      id,
      title: cur.title,
      status: running.length ? 'in_progress' : cur.status,
      details: details || undefined,
      output: cur.output,
    };
  }
  const status = tools.some((s) => s.interrupted) ? 'error' : 'complete';
  const one = tools[0];
  if (tools.length <= 1 && one?.status === 'error' && !one.interrupted)
    return { ...one, id, title: `${one.title} · failed`, status, final: true };
  if (tools.length <= 1) return { ...(one ?? steps.at(-1)!), id, final: true };
  const failed = tools.filter((s) => s.status === 'error');
  const full = tools.map((s) => `${mark(s)} ${s.title}`).join(' · ');
  return {
    id,
    title: `Ran ${tools.length} steps${failed.length ? ` · ${failed.length} failed` : ''}`,
    status,
    details: full.length <= DETAILS_MAX ? full : fitTail(compact(tools), DETAILS_MAX),
    output: failed.at(-1)?.output,
    final: true,
  };
}

/** The last `n` characters of a text on one line, for details and output tails. */
export function tail(s: string, n = 200) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t ? (t.length > n ? '…' + t.slice(-n) : t) : undefined;
}

/**
 * The tasks of the current turn and the run they are in. `out` gives the live
 * Segment to write into (creating or rotating it as the session sees fit);
 * `current` gives it only if there is one.
 */
export class Timeline {
  private tasks = new Map<string, Task>();
  private hidden = new Set<string>();
  private started = new Map<string, number>();
  /** Consecutive steps (tools, thinking) share one card; text between them starts a new one. */
  private run?: Run;
  /** Steps of closed runs: text followed their card, so it is history and takes no more updates. */
  private settled = new Set<string>();
  /** Runs closed with a step still running, written once more at the end of the turn. */
  private overtaken: Run[] = [];
  /** Steps dropped as never run; an update for one means that guess was wrong. */
  private abandoned = new Set<string>();

  constructor(
    private out: () => Segment,
    private current: () => Segment | undefined,
    /** Applied to every card's text: secret values never reach a card. */
    private redact: (s: string) => string = (s) => s,
  ) {}

  get(id: string) {
    return this.tasks.get(id);
  }

  /** The turn's first card, before the model shows anything: `Started`, which the first step replaces. */
  open() {
    const seg = this.out(); // may rotate first, which drops the current run
    const run = (this.run = { id: `run-${randomUUID().slice(0, 8)}`, steps: [], closed: false, opening: true });
    seg.task({ id: run.id, title: OPENING, status: 'in_progress', opening: true });
  }

  /** The opening card is still waiting for its first step. */
  get opening() {
    return !!this.run?.opening && !this.run.closed && !this.run.steps.length;
  }

  /** Settle an unclaimed opening card: done (text came first) or failed with `reason`. */
  private settleOpening(reason?: string) {
    const run = this.run!;
    run.closed = true;
    const done: Task = { id: run.id, title: OPENING, status: 'complete', final: true, opening: true };
    this.current()?.task(reason ? { ...done, status: 'error', details: reason } : done);
  }

  /** Internal plumbing the user doesn't need to watch: patches for it are dropped. */
  hide(id: string) {
    this.hidden.add(id);
  }

  /** `tick`: only the timer changed (Segment opens no new message for it). */
  setTask(t: Task, tick = false) {
    const r = this.redact;
    t = { ...t, title: r(t.title), details: t.details && r(t.details), output: t.output && r(t.output) };
    // An update here would land mid-text (Slack places a card where its update
    // arrives in the stream) or open a stray card, so it is only remembered.
    if (this.settled.has(t.id)) {
      if (!tick) log.info(`timeline: late update to settled step ${t.id} (${t.title}, ${t.status}) dropped`);
      this.tasks.set(t.id, t);
      return;
    }
    if (t.status === 'in_progress' && !this.started.has(t.id)) this.started.set(t.id, Date.now());
    this.tasks.set(t.id, t);
    const seg = this.out(); // may rotate first, which drops the current run
    let run = this.run;
    if (!run?.steps.includes(t.id)) {
      if (!run || run.closed) run = this.run = { id: `run-${randomUUID().slice(0, 8)}`, steps: [], closed: false };
      run.steps.push(t.id);
    }
    seg.task(rollup(run.id, this.runSteps(run), run.closed), { tick });
  }

  private runSteps(run: Run) {
    return run.steps.flatMap((id) => this.tasks.get(id) ?? []);
  }

  /**
   * Text is about to follow: the run is closed and takes no more updates, which
   * would land mid-text. If nothing in it runs it folds into its summary now;
   * otherwise its card stays as it is until the end of the turn.
   */
  closeRun() {
    const run = this.run;
    const seg = this.current();
    if (!run || run.closed || !seg) return;
    if (this.opening) return this.settleOpening();
    run.closed = true;
    for (const id of run.steps) this.settled.add(id);
    const steps = this.runSteps(run);
    if (steps.some((s) => s.status === 'in_progress')) this.overtaken.push(Object.assign(run, { seg }));
    else seg.task(rollup(run.id, steps, true));
  }

  /**
   * A model call starts: every tool result of the previous one has arrived, so
   * a step still running never ran (a call that broke off and was retried).
   * It leaves its run instead of ending the turn as a failure; a card left
   * with no steps says so.
   */
  abandonRunning() {
    for (const run of new Set([this.run, ...this.overtaken])) {
      if (!run) continue;
      const orphans = run.steps.filter((id) => {
        const t = this.tasks.get(id);
        return t?.status === 'in_progress' && !isThinking(t);
      });
      if (!orphans.length) continue;
      const first = this.tasks.get(orphans[0])!;
      run.steps = run.steps.filter((id) => !orphans.includes(id));
      for (const id of orphans) {
        this.tasks.delete(id);
        this.started.delete(id);
        this.abandoned.add(id);
      }
      log.info(`timeline: ${orphans.length} step(s) that never ran dropped (${first.title})`);
      const seg = run.seg ?? this.current();
      const steps = this.runSteps(run);
      // A spinner with nothing behind it must go; a closed run's card otherwise waits for the end of the turn.
      if (!steps.length) seg?.task({ id: run.id, title: first.title, status: 'pending', details: 'not run', final: true });
      else if (!run.closed) seg?.task(rollup(run.id, steps, false));
    }
    // A run emptied by its orphans is over; the opening card's run is still waiting for its first step.
    if (this.run && !this.run.steps.length && !this.opening) this.run = undefined;
    this.overtaken = this.overtaken.filter((r) => r.steps.length);
  }

  patchTask(id: string, patch: Partial<Task>, tick = false) {
    if (this.hidden.has(id)) return;
    if (this.abandoned.has(id)) return void (!tick && log.warn(`timeline: update to a step dropped as never run: ${id}`));
    const prev = this.tasks.get(id) ?? { id, title: '…', status: 'in_progress' as const };
    const next = { ...prev };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined || k === 'details') (next as any)[k] = v;
    // Waiting on the person: no counter while it lasts.
    if (patch.waiting) next.elapsed = undefined;
    this.setTask(next, tick);
  }

  /** The run's card belongs to a message that is going away (rotated or folded). */
  dropRun() {
    this.run = undefined;
  }

  /** Live elapsed time on slow tool calls, like Claude Code's running timer. */
  tick() {
    for (const [id, t0] of this.started) {
      const t = this.tasks.get(id);
      if (t?.status !== 'in_progress' || t.waiting || isThinking(t)) continue;
      const ms = Date.now() - t0;
      if (ms >= 4000) this.patchTask(id, { elapsed: fmtDuration(ms) }, true);
    }
  }

  /** The turn is over: running steps show as interrupted, the run closes, the state clears. `failure`: why, for an unclaimed opening card. */
  endTurn(failure?: string) {
    if (this.opening) this.settleOpening(failure);
    const interrupt = (id: string) => {
      const t = this.tasks.get(id);
      if (t?.status === 'in_progress') this.tasks.set(id, { ...t, status: 'error', details: 'interrupted', interrupted: true });
    };
    for (const run of this.overtaken) {
      run.steps.forEach(interrupt);
      run.seg?.task(rollup(run.id, this.runSteps(run), true));
    }
    if (this.run && !this.run.closed) {
      this.run.steps.forEach(interrupt);
      this.closeRun();
    }
    this.run = undefined;
    this.overtaken = [];
    this.tasks.clear();
    this.hidden.clear();
    this.started.clear();
    this.settled.clear();
    this.abandoned.clear();
  }
}
