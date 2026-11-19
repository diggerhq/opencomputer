// The Work index's Durable Object (tech design 3.6): binding `WORK_INDEX`, one per organization,
// addressed by account id like `COMPUTERS`. The logic is `WorkIndex` (index.ts); this is storage,
// the alarm and the Account object.

import { DurableObject } from "cloudflare:workers";

import type { TokenMinter } from "./github.js";
import { WorkIndex } from "./index.js";
import type { ItemsQuery, RepositoryChoice, WorkActor, WorkIndexRpc } from "./index-contract.js";

export interface WorkIndexEnv {
  /** The edge's AccountDurableObject, addressed by account id. */
  ACCOUNTS: DurableObjectNamespace;
}

export class WorkIndexDurableObject extends DurableObject<WorkIndexEnv> implements WorkIndexRpc {
  private index!: WorkIndex;

  constructor(ctx: DurableObjectState, env: WorkIndexEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.index = new WorkIndex({
        sql: ctx.storage.sql,
        transaction: (fn) => ctx.storage.transactionSync(fn),
        account: (accountId) => env.ACCOUNTS.getByName(accountId) as unknown as TokenMinter,
        arm: (at) => this.arm(at),
        waitUntil: (promise) => ctx.waitUntil(promise),
      });
    });
  }

  private async arm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  repository(accountId: string) {
    return this.index.getRepository(accountId);
  }

  setRepository(accountId: string, choice: RepositoryChoice, by: WorkActor) {
    return this.index.setRepository(accountId, choice, by);
  }

  items(accountId: string, query: ItemsQuery) {
    return this.index.items(accountId, query);
  }

  item(accountId: string, number: number) {
    return this.index.item(accountId, number);
  }

  history(accountId: string, number: number, cursor?: string) {
    return this.index.history(accountId, number, cursor);
  }

  poke(accountId: string) {
    return this.index.poke(accountId);
  }

  override async alarm(): Promise<void> {
    const next = await this.index.alarm();
    if (next !== null) await this.arm(Math.max(next, Date.now() + 1));
  }
}

/**
 * The organization's knowledge repository, or null when none is set (or the index is not bound).
 * The one call the knowledge-repository work (build step 2) makes of the Work index.
 */
export async function knowledgeRepository(env: { WORK_INDEX?: DurableObjectNamespace }, orgId: string) {
  if (!env.WORK_INDEX) return null;
  return (env.WORK_INDEX.getByName(orgId) as unknown as WorkIndexRpc).repository(orgId);
}
