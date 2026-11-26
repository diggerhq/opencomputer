// The knowledge repository routes' requests (spec 37: `PUT /work/repository`, `GET /work/repositories`),
// checked at the edge before Org is asked: the body's choice and the listing's query.

import { GRANTED_PAGES_MAX, type RepositoriesQuery, type RepositoryChoice } from "../../actors/org/contract.js";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const INSTALLATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

type Invalid = { status: 400; error: { code: "invalid_request"; message: string; field: string } };
const invalid = (message: string, field: string): Invalid => ({ status: 400, error: { code: "invalid_request", message, field } });

export function repositoryChoice(body: unknown): { value: RepositoryChoice } | { error: Invalid } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: invalid("The body must be a JSON object.", "") };
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!["installationId", "owner", "name", "branch"].includes(key)) return { error: invalid(`Unknown field ${key}.`, key) };
  }
  const { installationId, owner, name, branch } = input;
  const installation =
    typeof installationId === "number" && Number.isSafeInteger(installationId) && installationId > 0
      ? String(installationId)
      : typeof installationId === "string" && INSTALLATION_ID.test(installationId)
        ? installationId
        : null;
  if (installation === null) return { error: invalid("installationId is the GitHub installation's id.", "installationId") };
  if (typeof owner !== "string" || !OWNER.test(owner)) return { error: invalid("owner is a GitHub account login.", "owner") };
  if (typeof name !== "string" || !REPO_NAME.test(name) || name === "." || name === "..") return { error: invalid("name is a GitHub repository name.", "name") };
  if (branch !== undefined && branch !== null && (typeof branch !== "string" || !branchName(branch))) return { error: invalid("branch is a branch name.", "branch") };
  return { value: { installationId: installation, owner, name, ...(typeof branch === "string" ? { branch } : {}) } };
}

/** `GET /work/repositories`' query: `installation` and `page`, a later page only of one installation. */
export function repositoriesQuery(query: URLSearchParams): { value: RepositoriesQuery } | { error: Invalid } {
  for (const name of new Set(query.keys())) {
    if (name !== "installation" && name !== "page") return { error: invalid(`Unknown query parameter ${name}.`, name) };
  }
  const installation = query.get("installation");
  const rawPage = query.get("page");
  if (installation !== null && !INSTALLATION_ID.test(installation)) return { error: invalid("installation is an installation id.", "installation") };
  if (rawPage !== null && (!/^[1-9]\d{0,2}$/.test(rawPage) || Number(rawPage) > GRANTED_PAGES_MAX)) return { error: invalid(`page is 1 to ${GRANTED_PAGES_MAX}.`, "page") };
  if (rawPage !== null && rawPage !== "1" && installation === null) return { error: invalid("A later page is of one installation.", "installation") };
  return { value: { ...(installation !== null ? { installationId: installation } : {}), ...(rawPage !== null ? { page: Number(rawPage) } : {}) } };
}

/** A name `git check-ref-format --branch` accepts, at most 255 characters. */
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
