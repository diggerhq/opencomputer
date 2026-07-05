// Prompt-caching safety (buildout W3: "Handle prompt-caching-safe models").
//
// Some models route (via OpenRouter) to a backend that REJECTS Anthropic `cache_control` breakpoints
// — e.g. `claude-3-haiku` served through OR→Bedrock 400s the whole request. A Flue app written for
// Anthropic-native caching would then fail every turn on those models. Rather than restrict the model
// list (brittle as the catalog moves), the gateway STRIPS `cache_control` from the request body for a
// small, env-extensible denylist of known-unsafe models — the call still completes, just without
// caching. Models that support caching are untouched (no cost/perf regression).

const DEFAULT_UNSAFE: RegExp[] = [
  /claude-3-haiku/i, // OR→Bedrock rejects cache_control (observed 1a)
];

/** Build the unsafe-model matchers, extended by a comma-separated env list (CACHE_CONTROL_UNSAFE_MODELS). */
export function unsafeModelMatchers(extra?: string): RegExp[] {
  const list = [...DEFAULT_UNSAFE];
  if (extra) {
    for (const s of extra.split(",").map((x) => x.trim()).filter(Boolean)) {
      try {
        list.push(new RegExp(s, "i"));
      } catch {
        /* ignore an invalid pattern rather than break every request */
      }
    }
  }
  return list;
}

export function modelNeedsCacheStrip(model: unknown, matchers: RegExp[]): boolean {
  return typeof model === "string" && matchers.some((re) => re.test(model));
}

/** Recursively delete every `cache_control` property in place. Returns how many were removed. */
export function stripCacheControl(node: unknown): number {
  if (Array.isArray(node)) {
    let n = 0;
    for (const v of node) n += stripCacheControl(v);
    return n;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    let n = 0;
    if ("cache_control" in o) {
      delete o.cache_control;
      n++;
    }
    for (const k of Object.keys(o)) n += stripCacheControl(o[k]);
    return n;
  }
  return 0;
}
