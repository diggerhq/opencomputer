// The runner becomes its session's API writer (work 084): given RunnerSpec.api
// or `claim.api`, it takes the journal's lock (SessionLog.open), puts the tap
// on the session (SessionApi) and listens on the API socket for the host's
// relay. Without one (a pre-v4 host) the runner runs as it always did.

import { serveApi, type ApiServer } from '../../api/socket.js';
import { SessionLog } from '../../api/session-log.js';
import { createdOf } from '../../api/created.js';
import type { Person, RunnerApi, SessionSpec } from '../../protocol.js';
import type { Session } from '../session.js';
import { SessionApi, type SessionApiOptions } from './api.js';
import type { Telemetry } from '../../telemetry/emitter.js';
import { apiWriteEvent } from './write-events.js';

export interface AttachedApi {
  readonly api: SessionApi;
  close(): Promise<void>;
}

/** Waits this long for the journal's lock: the previous runner releases it as it exits. */
const LOCK_WAIT_MS = 5000;

export async function attachApi(
  spec: RunnerApi,
  session: Session,
  o: Omit<SessionApiOptions, 'owner'> & { owner: Person; redact?: (s: string) => string; spec?: SessionSpec; telemetry?: Telemetry },
): Promise<AttachedApi> {
  const { owner } = o;
  const log = await SessionLog.open(spec.journal, {
    sessionId: spec.sessionId,
    epoch: spec.epoch,
    lastSeq: spec.lastSeq,
    waitMs: LOCK_WAIT_MS,
    redact: o.redact,
    created: o.spec && createdOf(o.spec),
    seed: {
      sessionId: spec.sessionId,
      owner: { id: owner.userId ?? owner.slackUserId ?? 'owner', name: owner.name ?? owner.gitName, email: owner.email ?? null },
    },
  });
  const api = new SessionApi(log, session, { ...o, onWrite: o.onWrite ?? (o.telemetry && apiWriteEvent(o.telemetry)) });
  let server: ApiServer;
  try {
    server = await serveApi(spec.socket, api, { token: spec.token });
  } catch (e) {
    await log.release('moved');
    throw e;
  }
  api.resume(); // turns left queued in the journal (a runner that died, or the host's writer) start in order
  return {
    api,
    async close() {
      await Promise.all([server.close().catch(() => {}), api.close()]);
    },
  };
}
