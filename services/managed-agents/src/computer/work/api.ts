// The Work API (work tracking tech design 3.10), in the stateless Worker: validation, then the
// Work index's items composed with the Computer object's `work.context` for the caller. Neither
// object calls the other; this is the only place their answers meet.
//
// api-http.ts matches the routes, checks scopes and turns the `WorkReply` into a response.

import type { ApiCaller, ApiReply } from "../sessions-api.js";
import type { SessionBrief, WorkContext, WorkContextOp } from "./briefs.js";
import type { IndexedItem, ItemsResult, Revision, WorkIndexRpc } from "./index-contract.js";

export interface Person {
  email: string;
  name: string | null;
  id: string | null;
}

export interface ItemAttention {
  state: "needs_you" | "waiting_on" | "working";
  name: string | null;
  since: string;
}

/** `Item` of 3.10. */
export interface Item {
  number: number;
  stage: "open" | "closed";
  path: string;
  url: string;
  title: string;
  stateLine: string | null;
  tags: string[];
  owner: Person | null;
  author: Person | null;
  mine: boolean;
  left: number | null;
  readyToClose: boolean;
  warnings: string[];
  pullRequests: IndexedItem["pullRequests"];
  attention: ItemAttention | null;
  /** 3.10's `{id, title, ownerName}`, plus the session's lifecycle `status` (the board shows it). */
  sessions: { id: string; title: string | null; ownerName: string | null; status: SessionBrief["status"] }[];
  unpublished: boolean;
  updatedAt: string;
  createdAt: string | null;
  closedAt: string | null;
  closedBy: string | null;
}

export type WorkRouteOp = "work.repository.get" | "work.repository.put" | "work.items" | "work.item" | "work.history";

export interface WorkRoute {
  op: WorkRouteOp;
  /** The item number's path segment, unvalidated. */
  sub?: string;
}

/** An ApiReply, with the open list's ETag; status 304 has no body. */
export type WorkReply = ApiReply & { etag?: string };

export interface WorkDeps {
  accountId: string;
  caller: ApiCaller;
  /** The Work index, or null when the binding is missing. */
  index: WorkIndexRpc | null;
  /** The Computer object's `work.context`. */
  context(op: WorkContextOp): Promise<ApiReply>;
}

/** The query parameters each route takes; any other is refused. */
const PARAMS: Record<WorkRouteOp, readonly string[]> = {
  "work.repository.get": [],
  "work.repository.put": [],
  "work.items": ["stage", "cursor", "limit"],
  "work.item": [],
  "work.history": ["cursor"],
};

const CLOSED_LIMIT_MAX = 100;
const NUMBER = /^[1-9]\d{0,8}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[^\s~^:?*[\\]{1,255}$/;
const UNAVAILABLE: WorkReply = { status: 503, error: { code: "unavailable", message: "Work is unavailable. Try again shortly.", retryAfterMs: 5_000 } };

const invalid = (message: string, field: string): WorkReply => ({ status: 400, error: { code: "invalid_request", message, field } });
const notFound = (): WorkReply => ({ status: 404, error: { code: "item_not_found", message: "No such item." } });

/** One Work API request: validated, sent to the index, composed. Never throws for a refusal. */
export async function workApi(deps: WorkDeps, route: WorkRoute, query: URLSearchParams, body: unknown, ifNoneMatch: string | null): Promise<WorkReply> {
  for (const name of new Set(query.keys())) {
    if (!PARAMS[route.op].includes(name)) return invalid(`Unknown query parameter ${name}.`, name);
  }
  const index = deps.index;
  if (!index) return UNAVAILABLE;

  switch (route.op) {
    case "work.repository.get":
      return { status: 200, body: { repository: await index.repository(deps.accountId) } };

    case "work.repository.put": {
      const choice = repositoryChoice(body);
      if ("error" in choice) return choice.error;
      const by = { member: deps.caller.member, name: deps.caller.name, email: deps.caller.email };
      const result = await index.setRepository(deps.accountId, choice.value, by);
      if (!result.ok) {
        const { status, code, message, ok: _ok, ...extra } = result;
        return { status, error: { code, message, ...extra } };
      }
      return { status: 200, body: { repository: result.value } };
    }

    case "work.items": {
      const stage = query.get("stage");
      if (stage !== "open" && stage !== "closed") return invalid("stage is open or closed.", "stage");
      if (stage === "open") {
        for (const name of ["cursor", "limit"]) if (query.has(name)) return invalid(`${name} is only for stage=closed; the open list is whole.`, name);
      }
      const rawLimit = query.get("limit");
      if (rawLimit !== null && (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > CLOSED_LIMIT_MAX)) {
        return invalid(`limit is 1 to ${CLOSED_LIMIT_MAX}.`, "limit");
      }
      const cursor = query.get("cursor");
      const result: ItemsResult = await index.items(deps.accountId, {
        stage,
        ...(cursor !== null ? { cursor } : {}),
        ...(rawLimit !== null ? { limit: Number(rawLimit) } : {}),
      });
      if (!result.ok) return { status: 400, error: { code: "invalid_cursor", message: "The cursor is not valid for this list." } };
      const composed = await compose(deps, result.items, result.asOf);
      if ("status" in composed) return composed;
      if (stage === "closed") return { status: 200, body: { items: composed.items, nextCursor: result.nextCursor } };
      const page = { repository: result.repository, head: result.head, asOf: result.asOf, building: result.building, items: composed.items };
      const etag = await etagOf(page);
      if (ifNoneMatch !== null && matches(ifNoneMatch, etag)) return { status: 304, etag };
      return { status: 200, body: page, etag };
    }

    case "work.item": {
      if (!NUMBER.test(route.sub ?? "")) return notFound();
      const result = await index.item(deps.accountId, Number(route.sub));
      if (!result.item) return notFound();
      // A closed item's body is read on first view; GitHub could not be reached.
      if (result.body === null) return UNAVAILABLE;
      const composed = await compose(deps, [result.item], result.asOf);
      if ("status" in composed) return composed;
      return { status: 200, body: { item: composed.items[0]!, body: result.body } };
    }

    case "work.history": {
      if (!NUMBER.test(route.sub ?? "")) return notFound();
      const cursor = query.get("cursor");
      const result = await index.history(deps.accountId, Number(route.sub), cursor ?? undefined);
      if (!result.ok) {
        if (result.error === "item_not_found") return notFound();
        if (result.error === "invalid_cursor") return { status: 400, error: { code: "invalid_cursor", message: "The cursor is not valid for this list." } };
        return { ...UNAVAILABLE, error: { ...UNAVAILABLE.error!, retryAfterMs: result.retryAfterMs ?? 5_000 } };
      }
      const ids = [...new Set(result.revisions.map((r) => r.sessionId).filter((id): id is string => id !== null))];
      const context = ids.length ? await workContext(deps, ids, []) : { sessions: {}, people: {}, callerEmails: [] };
      if ("status" in context) return context;
      // A trailer names a session id or a Slack session's key: shown as the session's id, and only
      // when the caller may see it.
      const revisions: Revision[] = result.revisions.map((r) => ({ ...r, sessionId: r.sessionId ? (context.sessions[r.sessionId]?.id ?? null) : null }));
      return { status: 200, body: { revisions, nextCursor: result.nextCursor } };
    }
  }
}

function repositoryChoice(body: unknown): { value: { installationId: string; owner: string; name: string; branch?: string } } | { error: WorkReply } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: invalid("The body must be a JSON object.", "") };
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!["installationId", "owner", "name", "branch"].includes(key)) return { error: invalid(`Unknown field ${key}.`, key) };
  }
  const { installationId, owner, name, branch } = input;
  const installation =
    typeof installationId === "number" && Number.isSafeInteger(installationId) && installationId > 0
      ? String(installationId)
      : typeof installationId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(installationId)
        ? installationId
        : null;
  if (installation === null) return { error: invalid("installationId is the GitHub installation's id.", "installationId") };
  if (typeof owner !== "string" || !OWNER.test(owner)) return { error: invalid("owner is a GitHub account login.", "owner") };
  if (typeof name !== "string" || !REPO_NAME.test(name) || name === "." || name === "..") return { error: invalid("name is a GitHub repository name.", "name") };
  if (branch !== undefined && branch !== null && (typeof branch !== "string" || !BRANCH.test(branch))) return { error: invalid("branch is a branch name.", "branch") };
  return { value: { installationId: installation, owner, name, ...(typeof branch === "string" ? { branch } : {}) } };
}

async function workContext(deps: WorkDeps, sessionIds: string[], emails: string[]): Promise<WorkContext | WorkReply> {
  const reply = await deps.context({ op: "work.context", sessionIds, emails });
  if (reply.error) return reply;
  return reply.body as WorkContext;
}

/** The index's items joined with the caller's sessions and the members behind emails. */
async function compose(deps: WorkDeps, items: IndexedItem[], asOf: string | null): Promise<{ items: Item[] } | WorkReply> {
  const sessionIds = [...new Set(items.flatMap((i) => i.sessionIds))];
  const emails = [...new Set(items.flatMap((i) => [i.owner, i.author?.email ?? null]).filter((e): e is string => !!e).map((e) => e.toLowerCase()))];
  const context = items.length ? await workContext(deps, sessionIds, emails) : { sessions: {}, people: {}, callerEmails: [] };
  if ("status" in context) return context;
  const mine = new Set(context.callerEmails.map((e) => e.toLowerCase()));
  const person = (email: string, fallbackName: string | null = null): Person => {
    const known = context.people[email.toLowerCase()];
    return { email, name: known?.name ?? fallbackName, id: known?.id ?? null };
  };
  return {
    items: items.map((i): Item => {
      const briefs = linkedBriefs(i.sessionIds, context.sessions);
      return {
        number: i.number,
        stage: i.stage,
        path: i.path,
        url: i.url,
        title: i.title,
        stateLine: i.stateLine,
        tags: i.tags,
        owner: i.owner ? person(i.owner) : null,
        author: i.author?.email ? person(i.author.email, i.author.name) : null,
        mine: i.owner !== null && mine.has(i.owner.toLowerCase()),
        left: i.left,
        readyToClose: i.readyToClose,
        warnings: i.warnings,
        pullRequests: i.pullRequests,
        attention: itemAttention(briefs, deps.caller.member),
        sessions: briefs.map((b) => ({ id: b.id, title: b.title, ownerName: b.ownerName, status: b.status })),
        unpublished: false,
        updatedAt: i.updatedAt ?? i.closedAt ?? i.createdAt ?? asOf ?? new Date(0).toISOString(),
        createdAt: i.createdAt,
        closedAt: i.closedAt,
        closedBy: i.closedBy,
      };
    }),
  };
}

/** The item's linked sessions the caller may see, once each, in the index's order (most recent first). */
function linkedBriefs(ids: string[], sessions: Record<string, SessionBrief>): SessionBrief[] {
  const out = new Map<string, SessionBrief>();
  for (const id of ids) {
    const brief = sessions[id];
    if (brief && !out.has(brief.id)) out.set(brief.id, brief);
  }
  return [...out.values()];
}

/**
 * The item's attention for the caller, the first that holds over its visible sessions (3.10):
 * `needs_you` (one of the caller's sessions has an open ask), `waiting_on` (someone else's has),
 * `working` (one is starting or running). Until the session's `attention` field (3.7) lands, an
 * open ask is the only thing that needs a person.
 */
export function itemAttention(briefs: SessionBrief[], member: string): ItemAttention | null {
  const oldest = (list: SessionBrief[], at: (b: SessionBrief) => string) => list.reduce((a, b) => (at(b) < at(a) ? b : a));
  const asking = briefs.filter((b) => b.openAskAt !== null);
  const mineAsking = asking.filter((b) => b.ownerId === member);
  if (mineAsking.length) {
    const b = oldest(mineAsking, (x) => x.openAskAt!);
    return { state: "needs_you", name: b.ownerName, since: b.openAskAt! };
  }
  if (asking.length) {
    const b = oldest(asking, (x) => x.openAskAt!);
    return { state: "waiting_on", name: b.ownerName, since: b.openAskAt! };
  }
  const working = briefs.filter((b) => b.status === "running" || b.status === "starting");
  if (working.length) {
    const b = working.reduce((a, x) => (x.lastActiveAt > a.lastActiveAt ? x : a));
    return { state: "working", name: b.ownerName, since: b.lastActiveAt };
  }
  return null;
}

/**
 * The open list's ETag: the head, and a stamp of everything else the page says except `asOf`
 * (attention, sessions, people and pull request states change without a commit).
 */
export async function etagOf(page: { head: string | null; asOf: string | null }): Promise<string> {
  const { asOf: _asOf, ...rest } = page;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(rest)));
  const stamp = [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${page.head ?? "none"}-${stamp}"`;
}

function matches(ifNoneMatch: string, etag: string): boolean {
  return ifNoneMatch.split(",").some((tag) => {
    const t = tag.trim().replace(/^W\//, "");
    return t === "*" || t === etag;
  });
}

