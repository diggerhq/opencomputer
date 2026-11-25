// Org (tracks and threads, spec 17.3 and 36.1): one per organization, binding `ORGS`, named by the
// organization's id. The logic is in this directory's modules, pure functions over `Sql`; this
// class adds the storage, the alarm and the calls out.

import { DurableObject } from "cloudflare:workers";

import { alarms, migrate, owed, sqlOf, unavailable, type Sql } from "../actor/index.js";
import { STEPS } from "./schema.js";

export class OrgDurableObject extends DurableObject {
  private store: Sql | null = null;

  /** The object's SQL, migrated on first use. */
  protected get sql(): Sql {
    if (!this.store) {
      this.store = sqlOf(this.ctx.storage);
      migrate(this.store, STEPS);
    }
    return this.store;
  }

  /** Org is reached by RPC only. */
  override fetch(): Response {
    return unavailable("Org");
  }

  override async alarm(): Promise<void> {
    const sql = this.sql;
    await alarms.run(sql, Date.now(), { owed: () => owed.run(sql, () => Promise.reject(new Error("not yet")), Date.now()) });
  }
}
