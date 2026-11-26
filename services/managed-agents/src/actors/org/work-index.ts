// The retired Work board's Durable Object (binding `WORK_INDEX`), kept only because the class
// exists in production: a deploy may not drop it without a `deleted_classes` migration, and no
// deploy carries a DO migration. It indexes nothing and arms no alarm. Its one call is the
// knowledge repository setting it stored, which Org's one-shot `board` alarm copies (spec 43.1).
//
// Removed in a later by-hand deploy, once Org has run that alarm everywhere: this file, the
// `WORK_INDEX` bindings and a `deleted_classes: ["WorkIndexDurableObject"]` migration.

import { DurableObject } from "cloudflare:workers";

import type { StoredRepository } from "./repository.js";

export class WorkIndexDurableObject extends DurableObject {
  /** The setting as the Work index stored it (`meta.repo`), or null. */
  repository(): StoredRepository | null {
    const sql = this.ctx.storage.sql;
    if (!sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length) return null;
    const row = sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'repo'").toArray()[0];
    if (!row) return null;
    const repo = JSON.parse(row.v) as StoredRepository;
    return { installationId: repo.installationId, owner: repo.owner, name: repo.name, branch: repo.branch, ...(repo.id !== undefined ? { id: repo.id } : {}) };
  }

  /** An alarm the board armed before this version: nothing to do, and none is armed again. */
  override async alarm(): Promise<void> {}
}
