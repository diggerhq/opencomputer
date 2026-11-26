// What the SessionLog DO has acked, per session, kept across host restarts
// (work 084, "The mirror"): a host that restarts under running runners
// resumes each session's mirror from its last ack rather than from seq 1.
//
// Invariants: one small JSON file in the host's own data directory (never the
// journals' directory, which the runners' user can write); written at most
// every `debounceMs` and on `close`, by rename, so a crash leaves the previous
// copy. Losing the last second of acks only means those events go up again
// (the DO upserts by seq).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AckStore } from './api-bridge.js';

type Acks = Record<string, { epoch: number; seq: number }>;

export function mirrorAcks(file: string, debounceMs = 1000): AckStore & { close(): void } {
  let acks: Acks = {};
  try {
    acks = JSON.parse(readFileSync(file, 'utf8'));
  } catch {}
  let timer: NodeJS.Timeout | undefined;
  const save = () => {
    timer = undefined;
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.tmp`, JSON.stringify(acks), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch {}
  };
  return {
    get: (sessionId) => acks[sessionId],
    set(sessionId, epoch, seq) {
      const a = acks[sessionId];
      if (a && (a.epoch > epoch || (a.epoch === epoch && a.seq >= seq))) return;
      acks[sessionId] = { epoch, seq };
      timer ??= setTimeout(save, debounceMs);
      timer.unref?.();
    },
    close() {
      if (timer) clearTimeout(timer);
      save();
    },
  };
}
