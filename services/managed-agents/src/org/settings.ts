// Org's settings operations (spec 36.1), as the reference shape of an actor operation in Effect:
//
//   - the DO method (durable-object.ts) stays a thin plain shell: it calls `setSettings` and returns;
//   - the logic is an Effect program: typed errors, the contract's Schema, the actor's storage as a
//     service (`ActorSql`), no Durable Object in sight, so a test provides any SQLite;
//   - the program runs inside the DO's synchronous transaction (actor/in-transaction.ts), so nothing
//     can yield between two storage operations.
//
// The program's typed failures become the actor's plain `Refusal` at the edge of the method: RPC
// returns data, never Effect values.

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import type { Principal } from "../actor/principal.js";
import type { Reply } from "../actor/contracts.js";
import type { Sql } from "../actor/sql.js";
import { ActorSql, inTransaction } from "../actor/in-transaction.js";
import { issueOf } from "../contract/errors.js";
import { type OrgSettings, SettingsPatch } from "../contract/settings.js";
import { refusal } from "./sessions.js";
import { isMember } from "./tx.js";

export type { OrgSettings };

class AdminRequired extends Data.TaggedError("AdminRequired") {}
class InvalidPatch extends Data.TaggedError("InvalidPatch")<{ readonly field: string; readonly message: string }> {}

const DEFAULTS: OrgSettings = { apiAccessDefault: "owner" };

const read = ActorSql.useSync((sql): OrgSettings => {
  const row = sql.exec<{ api_access_default: string | null }>("SELECT api_access_default FROM meta WHERE k = 1")[0]!;
  return { apiAccessDefault: row.api_access_default === "org" ? "org" : DEFAULTS.apiAccessDefault };
});

const decodePatch = (patch: unknown) =>
  Schema.decodeUnknownEffect(SettingsPatch)(patch ?? {}, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) => new InvalidPatch(issueOf(error.issue))),
  );

/** The program: who may, what the body says, the write, the result. */
export const update = (p: Principal, patch: unknown) =>
  Effect.gen(function* () {
    if (!(isMember(p) && p.admin)) return yield* new AdminRequired();
    const decoded = yield* decodePatch(patch);
    const sql = yield* ActorSql;
    if (decoded.apiAccessDefault) sql.exec("UPDATE meta SET api_access_default = ? WHERE k = 1", decoded.apiAccessDefault);
    return yield* read;
  });

/** The organization's settings; any member reads them. */
export function settings(sql: Sql): OrgSettings {
  return Effect.runSync(Effect.provideService(read, ActorSql, sql));
}

export function setSettings(sql: Sql, p: Principal, patch: unknown): Reply<{ settings: OrgSettings }> {
  const exit = inTransaction(sql, update(p, patch));
  if (Exit.isSuccess(exit)) return { ok: true, settings: exit.value };
  const error = exit.cause.reasons.find((r) => r._tag === "Fail")?.error;
  if (error?._tag === "AdminRequired") return refusal("admin_required", 403, "Only an organization admin can change these settings.");
  if (error?._tag === "InvalidPatch") return refusal("invalid_request", 400, error.message, { field: error.field });
  throw Exit.isFailure(exit) ? new Error("Org settings failed", { cause: exit.cause }) : new Error("unreachable");
}
