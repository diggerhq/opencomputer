// Model text on its way to Slack: the filter that drops <system-reminder>
// spans that occasionally leak into streamed text. It works on deltas, so it
// never sees a whole message. (SILENT, the reply that posts nothing, is in
// system-prompt.ts with the prompt that defines it.)

/** Drops <system-reminder>…</system-reminder> spans that occasionally leak into streamed text. */
export class ReminderFilter {
  /** `then` filters what passes this one (secret redaction); `end` marks a block's last text. */
  constructor(private then: (text: string, end: boolean) => string = (t) => t) {}
  private buf = '';
  private inside = false;
  private static OPEN = '<system-reminder>';
  private static CLOSE = '</system-reminder>';
  push(delta: string): string {
    this.buf += delta;
    let out = '';
    for (;;) {
      const tag = this.inside ? ReminderFilter.CLOSE : ReminderFilter.OPEN;
      const i = this.buf.indexOf(tag);
      if (i >= 0) {
        if (!this.inside) out += this.buf.slice(0, i);
        this.buf = this.buf.slice(i + tag.length);
        this.inside = !this.inside;
        continue;
      }
      // Hold back a possible partial tag at the end.
      const lt = this.buf.lastIndexOf('<');
      const keep = lt >= 0 && tag.startsWith(this.buf.slice(lt)) ? this.buf.length - lt : 0;
      if (!this.inside) out += this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(this.buf.length - keep);
      return this.then(out, false);
    }
  }
  flush(): string {
    const out = this.inside ? '' : this.buf;
    this.buf = '';
    this.inside = false;
    return this.then(out, true);
  }
}
