// PreviewDurableObject (work 074): one per preview name
// (`PREVIEWS.idFromName(name)`), the name's single source of truth. The
// organization's ComputerDurableObject claims and releases it; the previews
// Worker resolves it on every uncached request. No index and no cache in
// front of it other than the Worker's 10 s isolate cache, so a registration
// is live the moment `claim` returns.

import { DurableObject } from "cloudflare:workers";

import type { PreviewClaim, PreviewClaimResult, PreviewRecord, PreviewResolution } from "./registry.js";
import { HIT_WRITE_INTERVAL_MS, claimOutcome } from "./registry.js";

const RECORD = "record";
const DENIED = "denied";

export class PreviewDurableObject extends DurableObject {
  /**
   * Claims the name for an organization's port, or moves it to another port
   * of the same organization. Compare-and-set: a name another organization
   * holds, or one an administrator denied, is refused. The storage reads and
   * the write run under the object's input gate, so two claims cannot both win.
   */
  async claim(name: string, claim: PreviewClaim): Promise<PreviewClaimResult> {
    const [current, denied] = await Promise.all([
      this.ctx.storage.get<PreviewRecord>(RECORD),
      this.ctx.storage.get<boolean>(DENIED),
    ]);
    const outcome = claimOutcome(name, current ?? null, denied === true, claim, Date.now());
    if (outcome.ok) await this.ctx.storage.put(RECORD, outcome.record);
    return outcome;
  }

  async resolve(): Promise<PreviewResolution> {
    const [record, denied] = await Promise.all([
      this.ctx.storage.get<PreviewRecord>(RECORD),
      this.ctx.storage.get<boolean>(DENIED),
    ]);
    if (denied) return { state: "denied" };
    return record ? { state: "live", record } : { state: "free" };
  }

  /** Frees the name if this organization holds it; true when it did. */
  async release(organizationId: string): Promise<boolean> {
    const record = await this.ctx.storage.get<PreviewRecord>(RECORD);
    if (!record || record.organizationId !== organizationId) return false;
    await this.ctx.storage.delete(RECORD);
    return true;
  }

  /** A served response; written at most once per HIT_WRITE_INTERVAL_MS. */
  async hit(at: number): Promise<void> {
    const record = await this.ctx.storage.get<PreviewRecord>(RECORD);
    if (!record || at - record.lastHitAt < HIT_WRITE_INTERVAL_MS) return;
    await this.ctx.storage.put(RECORD, { ...record, lastHitAt: at });
  }

  /** Administrator kill switch: drops the registration and keeps the name unusable until `allow`. */
  async deny(): Promise<PreviewRecord | null> {
    const record = (await this.ctx.storage.get<PreviewRecord>(RECORD)) ?? null;
    await this.ctx.storage.delete(RECORD);
    await this.ctx.storage.put(DENIED, true);
    return record;
  }

  async allow(): Promise<void> {
    await this.ctx.storage.delete(DENIED);
  }
}
