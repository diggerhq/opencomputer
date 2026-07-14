// Telemetry: forward Flue lifecycle/usage observations to OC_INGEST for the operator panel + spend
// attribution (design 013 §4; buildout Integration seams). The DO transcript stays authoritative — the
// TAILER is the event-truth path; `observe()` is a best-effort side channel, so this is fire-and-forget
// and never blocks or breaks a run. `observe` subscribers receive `ctx.env`, so this reads OC_INGEST per
// event and can be installed once at module load (isolate-scoped, matching observe's own scope).

import { observe } from "@flue/runtime";

interface CtxEnv { OC_INGEST?: string; OC_SESSION_TOKEN?: string }

/** Install the OC observation forwarder. Returns the unsubscribe fn. No-op per event when OC_INGEST unset. */
export function installOcObserver(): () => void {
  return observe((obs, ctx) => {
    try {
      const env = (ctx as { env?: CtxEnv }).env;
      if (!env?.OC_INGEST) return;
      const session = (obs as { session?: string }).session ?? (ctx as { id?: string }).id;
      void fetch(env.OC_INGEST, {
        method: "POST",
        headers: { "content-type": "application/json", ...(env.OC_SESSION_TOKEN ? { authorization: `Bearer ${env.OC_SESSION_TOKEN}` } : {}) },
        body: JSON.stringify({ session, agent: (ctx as { agentName?: string }).agentName, event: obs }),
      }).catch(() => {});
    } catch {
      /* telemetry must never break the run */
    }
  });
}
