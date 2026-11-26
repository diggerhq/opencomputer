// The mutation table (spec 37.3, 39): every mutation's name, its route and its arguments, once.
// Org's `MUTATIONS` (index.ts) is keyed by it and the API's routes (computer/api-http.ts) match it;
// the TypeScript SDK sends by it. The SDK ships on its own, so it holds a copy of this file
// (sdks/typescript/src/computer/mutation-table.ts, written by `npm run mutations` there, and held
// to this one by a test there). So this file imports nothing.
//
// A route's `{name}` segments are arguments taken from the path; the rest of the arguments are the
// body. `args` reach a mutation unchecked: these types are what a client sends, not a guarantee.

/** The arguments of each mutation, path ids included. */
export interface MutationArgs {
  "thread.rename": { sid: string; title: string };
  "thread.place": { sid: string; trackId: string | null };
  "thread.done": { sid: string; outcome?: string };
  "thread.reopen": { sid: string };
  "thread.keep": { sid: string; keep: boolean };
  "thread.ready": { sid: string; what: string; resultId?: string };
  "thread.attention": { sid: string; what: string | null };
  /** `By` values: `user:usr_…`, `agent:cs_…`. */
  "thread.writers": { sid: string; writers: "members" | string[] };
  "thread.delete": { sid: string };
  "track.create": { tid: string; agentSessionId: string; name?: string; sid?: string; firstInput?: string };
  "track.rename": { tid: string; name: string };
  "track.set_stand": { tid: string; stand: string };
  "track.done": { tid: string; outcome?: string };
  "track.reopen": { tid: string };
  "track.keep": { tid: string; keep: boolean };
  "track.dissolve": { tid: string; threads: "keep" | "stop" };
  "track.delete": { tid: string };
  "read.set": { sid: string; seq: number };
  "pref.set": { key: string; value: unknown };
  "doc.save": { tid: string; baseRev: number; text: string; spans: { from: number; to: number; by: string }[] };
  "result.add": { resultId: string; sid: string; kind: "pr" | "changes" | "preview" | "file" | "document"; ref: string; title: string; meta?: Record<string, unknown> };
  /** `parts` as review.v1.json has them. */
  "review.save": { resultId: string; head: string; parts: unknown[] };
  "proposal.create": { proposalId: string; kind: "done" | "wrap" | "move" | "edit"; target: string; what: string; args?: Record<string, unknown> };
  "proposal.accept": { proposalId: string };
  "proposal.dismiss": { proposalId: string };
  undo: { opId: string; resolution?: "force" };
}

export type MutationName = keyof MutationArgs;

/** Each mutation's method and path, under the Computer API's root. */
export const MUTATION_ROUTES: Record<MutationName, readonly [method: string, path: string]> = {
  "thread.rename": ["PUT", "/work/threads/{sid}/title"],
  "thread.place": ["PUT", "/work/threads/{sid}/track"],
  "thread.done": ["PUT", "/work/threads/{sid}/done"],
  "thread.reopen": ["DELETE", "/work/threads/{sid}/done"],
  "thread.keep": ["PUT", "/work/threads/{sid}/keep"],
  "thread.ready": ["PUT", "/work/threads/{sid}/ready"],
  "thread.attention": ["PUT", "/work/threads/{sid}/attention"],
  "thread.writers": ["PUT", "/work/threads/{sid}/writers"],
  "thread.delete": ["DELETE", "/work/threads/{sid}"],
  "track.create": ["POST", "/work/tracks"],
  "track.rename": ["PUT", "/work/tracks/{tid}/name"],
  "track.set_stand": ["PUT", "/work/tracks/{tid}/stand"],
  "track.done": ["PUT", "/work/tracks/{tid}/done"],
  "track.reopen": ["DELETE", "/work/tracks/{tid}/done"],
  "track.keep": ["PUT", "/work/tracks/{tid}/keep"],
  "track.dissolve": ["POST", "/work/tracks/{tid}/dissolve"],
  "track.delete": ["DELETE", "/work/tracks/{tid}"],
  "read.set": ["PUT", "/work/reads/{sid}"],
  "pref.set": ["PUT", "/work/prefs/{key}"],
  "doc.save": ["PUT", "/work/tracks/{tid}/doc"],
  "result.add": ["PUT", "/work/results/{resultId}"],
  "review.save": ["PUT", "/work/results/{resultId}/review"],
  "proposal.create": ["POST", "/work/proposals"],
  "proposal.accept": ["POST", "/work/proposals/{proposalId}/accept"],
  "proposal.dismiss": ["POST", "/work/proposals/{proposalId}/dismiss"],
  undo: ["POST", "/work/ops/{opId}/undo"],
};

/** A mutation as a request: its method, its path with the path's arguments, and the rest as the body. */
export function mutationRequest(name: MutationName, args: Record<string, unknown>): { method: string; path: string; body: Record<string, unknown> } {
  const [method, template] = MUTATION_ROUTES[name];
  const body = { ...args };
  const path = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = body[key];
    delete body[key];
    return encodeURIComponent(String(v));
  });
  return { method, path, body };
}

/** The mutation a request names, and the arguments in its path; null when it names none. */
export function matchMutation(method: string, path: string): { name: MutationName; args: Record<string, string> } | null {
  const segments = path.split("/").filter(Boolean);
  for (const [name, [m, template]] of Object.entries(MUTATION_ROUTES) as [MutationName, readonly [string, string]][]) {
    const parts = template.split("/").filter(Boolean);
    if (m !== method || parts.length !== segments.length) continue;
    const args: Record<string, string> = {};
    let same = true;
    parts.forEach((part, i) => {
      if (part.startsWith("{")) args[part.slice(1, -1)] = segments[i]!;
      else if (part !== segments[i]) same = false;
    });
    if (same) return { name, args };
  }
  return null;
}
