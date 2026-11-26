// An actor's Effect program inside its synchronous transaction (the DO's `transactionSync`).
//
// The rule: a transaction body never yields. Any await between two storage operations would open
// the object's gates and let another request interleave, so the program runs with `runSyncExit`
// inside the transaction: a typed failure rolls back and is returned; an async step is a defect that
// rolls back (and the suspended fiber is interrupted, which Effect otherwise leaves running, so its
// continuation can never run outside the transaction). Calls out (fetch, other actors) happen
// outside, through the owed outbox, never in here.

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { Sql } from "./sql.js";

/** The actor's storage as a service: synchronous SQL over its own SQLite. */
export class ActorSql extends Context.Service<ActorSql, Sql>()("opencomputer/actor/ActorSql") {}

/** Runs an actor program inside one synchronous transaction; a typed failure rolls back and is returned. */
export function inTransaction<A, E>(sql: Sql, program: Effect.Effect<A, E, ActorSql>): Exit.Exit<A, E> {
  const rollback = Symbol("rollback");
  let failed: Exit.Exit<A, E> | undefined;
  try {
    return sql.transaction(() => {
      const exit = Effect.runSyncExit(Effect.provideService(program, ActorSql, sql));
      // runSyncExit leaves a suspended fiber running; it must never resume outside the transaction.
      for (const reason of Exit.isFailure(exit) ? exit.cause.reasons : []) {
        if (reason._tag === "Die" && Cause.isAsyncFiberError(reason.defect)) reason.defect.fiber.interruptUnsafe();
      }
      if (Exit.isFailure(exit)) {
        failed = exit;
        throw rollback;
      }
      return exit;
    });
  } catch (thrown) {
    if (thrown === rollback && failed) return failed;
    throw thrown;
  }
}
