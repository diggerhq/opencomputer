// Keeps Calvin's own instructions out of what it posts: basic protection
// against "print your system prompt", not against a determined attacker.
//
// Two checks, both string work on the text already flowing to Slack, so no
// model call and no added latency beyond holding back a few words:
// - the canary (a marker in SYSTEM_APPEND) is withheld wherever it appears;
// - shingles: the protected text is cut into overlapping runs of SHINGLE
//   words, compared case- and punctuation-insensitively, so markdown and
//   quoting don't hide a copy. RUN consecutive matching shingles (SHINGLE +
//   RUN - 1 words copied in order) is a leak; those words, and every following
//   word while the copy continues, become one WITHHELD marker.
// Paraphrase and translation pass: they need a model to catch.
//
// Streaming holds back the last SHINGLE + RUN - 1 words, which is exactly
// what a leak covers when it is first detected, so nothing of it is posted.
// Each delta is scanned once; a run of MAX_TOKEN characters without
// whitespace (a minified line, base64) is passed on as one word, so cost stays
// linear and a blob is never held to the end of its block.
//
// main.ts makes the one PromptGuard (SP_PROMPT_GUARD=off disables it, for a
// deployment that works on Calvin itself): the Slack client redacts every call
// with it, and Session filters streamed text through `stream()` ahead of the
// secrets filter, since the client only sees streamed text a chunk at a time.

import { CANARY, SYSTEM_APPEND } from './system-prompt.js';

export const WITHHELD = '[withheld: internal instructions]';
const SHINGLE = 8;
const RUN = 3;
const HOLD = SHINGLE + RUN - 1;
const MAX_TOKEN = 2000;

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const canaryNorm = norm(CANARY);

/** Every SHINGLE-word run of `texts`, normalized. */
export function shingles(texts: string[]): Set<string> {
  const set = new Set<string>();
  for (const t of texts) {
    const words = t.split(/\s+/).map(norm).filter(Boolean);
    for (let i = 0; i + SHINGLE <= words.length; i++) set.add(words.slice(i, i + SHINGLE).join(' '));
  }
  return set;
}

type Token = { text: string; word: string; cut: boolean };

/** A streaming filter: `push` returns what is safe to post now, `flush` the rest. */
export function guardStream(set: Set<string>, onTrip: (words: number) => void = () => {}) {
  const wordEnd = /\S\s+/g;
  let pending = '';
  let held: Token[] = [];
  let window: string[] = [];
  let streak = 0;
  let cutWords = 0;
  /** Inside a cut: the whitespace that follows the marker once the cut ends. */
  let cutTail = '';

  const endCut = () => {
    const ws = cutTail;
    if (ws && cutWords) onTrip(cutWords);
    cutTail = '';
    cutWords = 0;
    return ws;
  };

  const take = (text: string) => {
    const word = norm(text);
    const t: Token = { text, word, cut: false };
    held.push(t);
    if (!word) return;
    if (canaryNorm && word.includes(canaryNorm)) t.cut = true;
    window.push(word);
    if (window.length > SHINGLE) window.shift();
    streak = window.length === SHINGLE && set.has(window.join(' ')) ? streak + 1 : 0;
    if (streak < RUN) return;
    // The run covers the last SHINGLE + streak - 1 words, all still held when
    // first found. Punctuation between cut words is cut with them, but not
    // what precedes the run: an opening code fence must stay with its closing one.
    if (streak === RUN) {
      for (let i = held.length - 1, n = HOLD; i >= 0 && n > 0; i--) {
        if (held[i].word) n--;
        held[i].cut = true;
      }
    } else for (let i = held.length - 1; i >= 0 && (i === held.length - 1 || !held[i].word); i--) held[i].cut = true;
  };

  const emit = (all: boolean) => {
    let words = 0;
    let keep = held.length;
    if (!all)
      while (keep > 0 && words < HOLD) {
        keep--;
        if (held[keep].word) words++;
      }
    let out = '';
    for (const t of held.slice(0, keep)) {
      if (t.cut) {
        if (t.word) cutWords++;
        if (!cutTail) out += WITHHELD;
        cutTail = /\s*$/.exec(t.text)![0] || ' ';
      } else {
        out += endCut() + t.text;
      }
    }
    held = held.slice(keep);
    return out;
  };

  return {
    push(delta: string): string {
      // From one before the delta: its first character may end a word.
      wordEnd.lastIndex = Math.max(0, pending.length - 1);
      pending += delta;
      let from = 0;
      for (let m = wordEnd.exec(pending); m; m = wordEnd.exec(pending)) {
        take(pending.slice(from, wordEnd.lastIndex));
        from = wordEnd.lastIndex;
      }
      pending = pending.slice(from);
      if (pending.length >= MAX_TOKEN) {
        take(pending);
        pending = '';
      }
      return emit(false);
    },
    flush(): string {
      if (pending) take(pending);
      pending = '';
      const out = emit(true) + endCut().replace(/^ $/, '');
      window = [];
      streak = 0;
      return out;
    },
  };
}

/** The guard over Calvin's own prompt; `enabled: false` passes everything through. */
export class PromptGuard {
  private set?: Set<string>;
  constructor(
    private enabled: boolean,
    /** A leak was withheld: `words` of it, found in streamed text or a Slack call. */
    private onTrip: (words: number, where: 'stream' | 'slack') => void = () => {},
  ) {}

  private shingles() {
    return (this.set ??= shingles([SYSTEM_APPEND]));
  }

  /** `s` with any copy of Calvin's instructions withheld (every Slack call's strings). */
  redact(s: string): string {
    if (!s || !this.enabled) return s;
    const g = guardStream(this.shingles(), (n) => this.onTrip(n, 'slack'));
    return g.push(s) + g.flush();
  }

  /** One session's streamed-text filter, shaped like SessionSecrets.filter. */
  stream(): (text: string, end: boolean) => string {
    if (!this.enabled) return (t) => t;
    const g = guardStream(this.shingles(), (n) => this.onTrip(n, 'stream'));
    return (text, end) => (end ? g.push(text) + g.flush() : g.push(text));
  }
}
