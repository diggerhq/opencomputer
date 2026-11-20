// One thing at a time per thread (work 103, "Sequences"): a start (new,
// resume, claim) and whatever removes a thread's container, home, workspace or
// run directory (prune.ts, artifacts.ts, the sweep's run directories) take the
// thread's turn here, so neither ever works on what the other is half through.
//
// Invariants:
// - A thread is its person and its key, never its sandbox id: a start that
//   waited for a prune looks its record up only once it has the turn, and
//   finds none (a new thread) or the one a kept thread still has.
// - Turns are given in the order they were asked for. A turn ends when its
//   function settles, whatever it settles with; the next one starts then.
// - Nothing here times out: every holder bounds its own steps (podman.ts).
// - In memory only: one host process owns its threads (containers.ts).

export interface ThreadLocks {
  /** Run `fn` once every turn asked for before it, for this thread, has ended. */
  run<T>(person: string, key: string, fn: () => Promise<T>): Promise<T>;
  /** True while a turn of this thread runs or waits. */
  busy(person: string, key: string): boolean;
}

export function threadLocks(): ThreadLocks {
  /** The end of the last turn asked for, by thread. */
  const tails = new Map<string, Promise<void>>();
  const name = (person: string, key: string) => `${person}\n${key}`;
  return {
    run(person, key, fn) {
      const k = name(person, key);
      const turn = (tails.get(k) ?? Promise.resolve()).then(fn);
      const tail = turn.then(() => undefined, () => undefined).then(() => void (tails.get(k) === tail && tails.delete(k)));
      tails.set(k, tail);
      return turn;
    },
    busy: (person, key) => tails.has(name(person, key)),
  };
}
