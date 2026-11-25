// GET /work/repositories (work tracking tech design 3.10): what the organization's GitHub
// installations grant, for the repository picker, read through the Work index. The repository
// setting itself and the Work items are Org's now (tracks and threads, spec 37).
//
// api-http.ts matches the route, checks the scope and turns the `WorkReply` into a response.

import type { ApiReply } from "../sessions-api.js";
import type { WorkIndexRpc } from "./index-contract.js";
import { GRANTED_PAGES_MAX } from "./index-contract.js";

export type WorkReply = ApiReply;

const PARAMS = ["installation", "page"];
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const INSTALLATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UNAVAILABLE: WorkReply = { status: 503, error: { code: "unavailable", message: "Work is unavailable. Try again shortly.", retryAfterMs: 5_000 } };

const invalid = (message: string, field: string): WorkReply => ({ status: 400, error: { code: "invalid_request", message, field } });

/** The installations' repositories, a page at a time. Never throws for a refusal. */
export async function workRepositories(accountId: string, index: WorkIndexRpc | null, query: URLSearchParams): Promise<WorkReply> {
  for (const name of new Set(query.keys())) {
    if (!PARAMS.includes(name)) return invalid(`Unknown query parameter ${name}.`, name);
  }
  if (!index) return UNAVAILABLE;
  const installation = query.get("installation");
  const rawPage = query.get("page");
  if (installation !== null && !INSTALLATION_ID.test(installation)) return invalid("installation is an installation id.", "installation");
  if (rawPage !== null && (!/^[1-9]\d{0,2}$/.test(rawPage) || Number(rawPage) > GRANTED_PAGES_MAX)) {
    return invalid(`page is 1 to ${GRANTED_PAGES_MAX}.`, "page");
  }
  if (rawPage !== null && rawPage !== "1" && installation === null) return invalid("A later page is of one installation.", "installation");
  const result = await index.repositories(accountId, {
    ...(installation !== null ? { installationId: installation } : {}),
    ...(rawPage !== null ? { page: Number(rawPage) } : {}),
  });
  if (!result.ok) return { ...UNAVAILABLE, error: { ...UNAVAILABLE.error!, retryAfterMs: result.retryAfterMs } };
  return { status: 200, body: { installations: result.installations } };
}

export function repositoryChoice(body: unknown): { value: { installationId: string; owner: string; name: string; branch?: string } } | { error: WorkReply } {
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
  if (branch !== undefined && branch !== null && (typeof branch !== "string" || !branchName(branch))) return { error: invalid("branch is a branch name.", "branch") };
  return { value: { installationId: installation, owner, name, ...(typeof branch === "string" ? { branch } : {}) } };
}

/**
 * A name `git check-ref-format --branch` accepts: no `.` or `..` segment, no segment starting with
 * `.` or ending with `.lock`, no `..`, `@{`, `//`, control characters, space or `~^:?*[\`, not `@`,
 * not starting with `-` or `/`, not ending with `/` or `.`. At most 255 characters.
 */
export function branchName(name: string): boolean {
  if (name.length < 1 || name.length > 255 || name === "@") return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x21 || c === 0x7f || "~^:?*[\\".includes(name[i]!)) return false;
  }
  return name.split("/").every((segment) => !segment.startsWith(".") && !segment.endsWith(".lock"));
}
