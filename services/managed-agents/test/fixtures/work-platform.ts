import type { Clock, IndexStore, StoreValue } from "../../src/computer/work/platform.js";
import { sqlStorage } from "./computer-sql.js";

/** Durable Object SQL binds at most 100 parameters per statement; the fake refuses more, as it does. */
const BIND_LIMIT = 100;

/** The Work index's store on node:sqlite (the computer modules' fake), with real transactions. */
export function indexStore(sql: SqlStorage = sqlStorage()): IndexStore & { sql: SqlStorage } {
  let depth = 0;
  return {
    sql,
    exec<T extends Record<string, StoreValue>>(query: string, ...params: StoreValue[]): T[] {
      if (params.length > BIND_LIMIT) throw new Error(`too many SQL variables: ${params.length}`);
      return sql.exec(query, ...params).toArray() as T[];
    },
    transaction<T>(fn: () => T): T {
      const name = `t${depth++}`;
      sql.exec(`SAVEPOINT ${name}`);
      try {
        const out = fn();
        sql.exec(`RELEASE ${name}`);
        return out;
      } catch (error) {
        sql.exec(`ROLLBACK TO ${name}`);
        sql.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        depth--;
      }
    },
  };
}

/** A clock moved by hand: `tick` advances it and runs the timers that come due. */
export class FakeClock implements Clock {
  private timers: { at: number; fn: () => void }[] = [];

  constructor(public t = Date.parse("2026-11-19T10:00:00Z")) {}

  now(): number {
    return this.t;
  }

  timeout(ms: number, fn: () => void): () => void {
    const timer = { at: this.t + ms, fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((x) => x !== timer);
    };
  }

  tick(ms: number): number {
    this.t += ms;
    const due = this.timers.filter((x) => x.at <= this.t);
    this.timers = this.timers.filter((x) => x.at > this.t);
    for (const timer of due) timer.fn();
    return this.t;
  }

  /** Timers waiting. */
  get waiting(): number {
    return this.timers.length;
  }
}
