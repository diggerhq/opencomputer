// Tool calls while the model writes them (work 084 A1): from a tool block's
// start to its complete `tool` record, the `tool.preparing` delta says which
// tool is coming, with its path and description once their strings are
// complete, and how many lines of content (Write, Edit) it has written so far,
// so a client shows `Write src/x.ts · writing… 212 lines` instead of 12 s of
// nothing. Built from the provider's partial JSON, never parsed whole.
//
// Invariants:
// - at most one delta per call per PREPARING_INTERVAL_MS after its first
//   (which goes out at the block's start), and only when something changed;
// - memory per call is bounded: keys are read from the input's first
//   HEAD_MAX characters; lines are counted as the input streams;
// - nothing is recorded: `tool.started` stays the call's first event.

export const PREPARING_INTERVAL_MS = 250;
const HEAD_MAX = 8 * 1024;
const DESCRIPTION_MAX = 200;
const PATH_KEY = /"(?:file_path|notebook_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const DESCRIPTION_KEY = /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/;
/** The input key whose string is the content being written; lines count from its start. */
const CONTENT_KEY = /"(?:content|new_string|new_source)"\s*:\s*"/;

export interface PreparingData {
  subagentId: string | null;
  callId: string;
  toolName: string;
  path: string | null;
  description: string | null;
  lines: number | null;
}

interface Open extends PreparingData {
  head: string;
  /** The input's last characters: a key or a `\n` escape split across deltas. */
  win: string;
  sentAt: number;
  dirty: boolean;
}

const jsonString = (s: string) => {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
};

export class PreparingCalls {
  private open = new Map<string, Open>();

  constructor(
    private emit: (d: PreparingData) => void,
    private now: () => number,
    private rel: (path: string) => string = (p) => p,
  ) {}

  /** A tool block started. */
  start(callId: string, toolName: string) {
    const p: Open = { subagentId: null, callId, toolName, path: null, description: null, lines: null, head: '', win: '', sentAt: 0, dirty: false };
    this.open.set(callId, p);
    this.send(p);
  }

  /** More of its input. */
  input(callId: string, delta: string) {
    const p = this.open.get(callId);
    if (!p) return;
    if (p.head.length < HEAD_MAX) {
      p.head += delta.slice(0, HEAD_MAX - p.head.length);
      const path = p.path ?? PATH_KEY.exec(p.head)?.[1];
      const description = p.description ?? DESCRIPTION_KEY.exec(p.head)?.[1];
      if (path !== undefined && p.path === null) (p.path = this.rel(jsonString(path))), (p.dirty = true);
      if (description !== undefined && p.description === null) (p.description = jsonString(description).slice(0, DESCRIPTION_MAX)), (p.dirty = true);
    }
    this.count(p, delta);
    if (p.dirty && this.now() - p.sentAt >= PREPARING_INTERVAL_MS) this.send(p);
  }

  /** Its complete call arrived (`tool.started` follows), or the turn ended. */
  end(callId: string) {
    this.open.delete(callId);
  }

  clear() {
    this.open.clear();
  }

  private count(p: Open, delta: string) {
    const text = p.win + delta;
    let from = 0;
    if (p.lines === null) {
      const m = CONTENT_KEY.exec(text);
      if (!m) return void (p.win = text.slice(-24));
      p.lines = 1;
      p.dirty = true;
      from = m.index + m[0].length;
    }
    for (let i = text.indexOf('\\n', from); i >= 0; i = text.indexOf('\\n', i + 2)) (p.lines += 1), (p.dirty = true);
    p.win = text.slice(-1);
  }

  private send(p: Open) {
    p.sentAt = this.now();
    p.dirty = false;
    this.emit({ subagentId: p.subagentId, callId: p.callId, toolName: p.toolName, path: p.path, description: p.description, lines: p.lines });
  }
}
