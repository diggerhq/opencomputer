// A session's / turn's `usage` is an opaque, runtime-authored object — its shape
// varies by runtime (brain-box runtimes report token counts + sometimes a cost;
// flue currently emits `{}`, with spend metered authoritatively at the gateway).
// Extract the human-meaningful bits defensively — never assume a field is present.

export type UsageLike = Record<string, unknown> | null | undefined

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function hasUsage(usage: UsageLike): boolean {
  return !!usage && Object.keys(usage).length > 0
}

// Cost in USD if the runtime reported one — several field spellings appear across runtimes.
export function usageCostUsd(usage: UsageLike): number | null {
  if (!usage) return null
  const u = usage
  for (const k of ['cost_usd', 'total_cost_usd', 'cost', 'total_cost', 'usd']) {
    const n = num(u[k])
    if (n !== null) return n
  }
  return null
}

// Total tokens, summing input/output when a direct total isn't given.
export function usageTokens(usage: UsageLike): number | null {
  if (!usage) return null
  const u = usage
  const total = num(u.total_tokens) ?? num(u.tokens)
  if (total !== null) return total
  const inp = num(u.input_tokens) ?? num(u.prompt_tokens)
  const out = num(u.output_tokens) ?? num(u.completion_tokens)
  if (inp !== null || out !== null) return (inp ?? 0) + (out ?? 0)
  return null
}

// Sub-cent per-session spend is common; show enough precision to stay non-zero.
export function formatUsd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

// A compact one-line spend label for a table cell / metric: "$0.0230", "1,240 tok", or "—".
export function formatSpend(usage: UsageLike): string {
  const cost = usageCostUsd(usage)
  if (cost !== null) return formatUsd(cost)
  const tok = usageTokens(usage)
  if (tok !== null) return `${tok.toLocaleString()} tok`
  return '—'
}
