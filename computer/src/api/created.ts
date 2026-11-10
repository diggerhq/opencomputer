// `session.created`, the first event of every session's log (work 084): built
// from the SessionSpec by whichever writer opens an empty journal first, the
// runner or the host (SessionLog.open records it). The DO never synthesizes
// it, since a synthesized seq 1 would collide with the writer's seq 1
// (requests-blue (c)).

import type { SessionSpec } from '../protocol.js';

export interface SessionCreated {
  title: string;
  origin: {
    type: string;
    client: string | null;
    slack: { teamId: string | null; channelId: string; channelName: string | null; threadTs: string | null; url: string | null } | null;
  };
  settings: { model: string | null; effort: string | null; mode: string; speed: string | null };
}

export function createdOf(spec: SessionSpec): SessionCreated {
  const slack = spec.channel
    ? { teamId: spec.teamId ?? null, channelId: spec.channel, channelName: null, threadTs: spec.threadTs ?? null, url: null }
    : null;
  return {
    title: spec.title,
    origin: { type: spec.origin?.type ?? (slack ? 'slack' : 'api'), client: spec.origin?.client ?? null, slack },
    settings: { model: spec.model ?? null, effort: spec.effort ?? null, mode: spec.mode, speed: spec.speed ?? null },
  };
}
