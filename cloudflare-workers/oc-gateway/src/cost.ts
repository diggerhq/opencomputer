// Per-response cost extraction — the on-path meter's input (design 013 §4, token-billing §9.7).
//
// OpenRouter echoes cost on both the Anthropic Messages and OpenAI paths (verified live 2026-06-29,
// token-billing.md §9.7): a `usage` object carries a `cost` field in USD when usage accounting is
// on. We inject `usage:{include:true}` into the request (openrouter.ts precedent) so the field is
// present, then read it here. Fallbacks, in order: `usage.cost` → `usage.total_cost` → null (we log
// and count 0, flagged — never guess a price). The AUTHORITATIVE org-level cost stays OpenRouter's
// per-key cumulative usage (the cron); this is the fast on-path estimate for per-session enforcement.
//
// The OpenRouter generation id (`id` on the response) is returned too — it is the meter's idempotency
// key (so a retried /add never double-counts) AND the handle for the exact-cost fallback
// (GET /api/v1/generation?id=… — documented, not wired in the spike).

export interface ExtractedCost {
  costUsd: number | null; // null = cost not found in the echo (flagged; counted as 0)
  generationId: string | null;
  source: "usage.cost" | "usage.total_cost" | "none";
}

function readCost(usage: unknown): { usd: number; source: ExtractedCost["source"] } | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  if (typeof u.cost === "number") return { usd: u.cost, source: "usage.cost" };
  if (typeof u.total_cost === "number") return { usd: u.total_cost, source: "usage.total_cost" };
  return null;
}

/** Extract cost + generation id from a fully-buffered JSON response body. */
export function costFromJson(bodyText: string): ExtractedCost {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(bodyText); } catch { return { costUsd: null, generationId: null, source: "none" }; }
  const id = typeof obj.id === "string" ? obj.id : null;
  const hit = readCost(obj.usage);
  return { costUsd: hit?.usd ?? null, generationId: id, source: hit?.source ?? "none" };
}

/** Extract cost + generation id from an SSE stream body (text/event-stream). Scans `data:` lines for
 *  the terminal usage — Anthropic emits `message_delta`/`message_stop` with usage; OR's cost rides the
 *  final usage. Reads the whole (already-teed) stream; the client copy is untouched. */
export async function costFromStream(stream: ReadableStream<Uint8Array>): Promise<ExtractedCost> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let best: ExtractedCost = { costUsd: null, generationId: null, source: "none" };
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const obj = JSON.parse(data) as Record<string, unknown>;
        if (typeof obj.id === "string" && !best.generationId) best.generationId = obj.id;
        // usage can sit at the top level or under a delta (`message_delta.usage`).
        const hit = readCost(obj.usage) ?? readCost((obj.message as Record<string, unknown> | undefined)?.usage);
        if (hit) best = { ...best, costUsd: hit.usd, source: hit.source };
      } catch { /* non-JSON keep-alive/comment line */ }
    }
    if (done) break;
  }
  return best;
}
