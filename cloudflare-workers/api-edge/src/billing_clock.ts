// Billing clock (serverless-agents-ws 086, step 4): the halts that come from
// time passing rather than usage. A trial ends on day 7 and a failing payment
// halts after its grace even when the org does nothing, so the */5 cron
// re-projects the orgs whose clock has run out; projectOrg decides and halts.
// A halted or paid-up org no longer matches. One that matches but stays
// unhalted (a credit-only signup before the Autumn trial plan exists) is
// re-projected every tick, so the batch takes the least recently updated rows
// first: projectOrg stamps updated_at, and such rows cannot starve the rest.

import { type AutumnEnv, PAYMENT_GRACE_DAYS, TRIAL_DAYS, projectOrg } from "./autumn_webhook";

const DAY_SEC = 86_400;
// Bounds one tick; the next tick continues.
const MAX_ORGS_PER_RUN = 50;

export async function runBillingClock(env: AutumnEnv, nowMs: number): Promise<number> {
  const nowSec = Math.floor(nowMs / 1000);
  const due = await env.OPENCOMPUTER_DB.prepare(
    `SELECT id FROM orgs
      WHERE billing_provider = 'autumn' AND is_halted = 0
        AND ((usage_plan = 'base' AND trial_started_at <= ?1) OR payment_past_due_at <= ?2)
      ORDER BY updated_at
      LIMIT ?3`,
  )
    .bind(nowSec - TRIAL_DAYS * DAY_SEC, nowSec - PAYMENT_GRACE_DAYS * DAY_SEC, MAX_ORGS_PER_RUN)
    .all<{ id: string }>();
  let projected = 0;
  for (const { id } of due.results ?? []) {
    try {
      await projectOrg(env, id);
      projected++;
    } catch (err) {
      console.error(`billing-clock: project ${id} failed`, err);
    }
  }
  return projected;
}
