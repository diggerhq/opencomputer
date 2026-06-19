import type { Event } from "./types.js";
import { normalize } from "./normalize.js";

// Parse a `text/event-stream` Response body into normalized events. Web-standard only
// (ReadableStream + TextDecoder) — works in Node 18+, browsers, Workers, and Deno. No
// EventSource (can't set auth headers) and no dependencies.
export async function* parseEventStream(res: Response): AsyncGenerator<Event> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frameData(frame);
        if (data) yield normalize<Event>(JSON.parse(data));
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

function frameData(frame: string): string | null {
  const data = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""))
    .join("\n");
  return data || null;
}
