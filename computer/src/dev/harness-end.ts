// The dev checks end a session's harness as a runner exit would (its process
// goes away), without the session knowing: its pump sees the stream end.
import { close, type Running } from '../runner/harness/types.js';
import type { Session } from '../runner/session.js';

export function endHarness(s: Session) {
  const run = (s as unknown as { run?: Running }).run;
  if (run) close(run);
}
