// The streaming-input side of a query: messages pushed here are yielded to
// the Agent SDK as they come, and the iterator waits while there are none.

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export class Inbox implements AsyncIterable<SDKUserMessage> {
  private buf: SDKUserMessage[] = [];
  private wake?: () => void;
  push(m: SDKUserMessage) {
    this.buf.push(m);
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.buf.length) yield this.buf.shift()!;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}
