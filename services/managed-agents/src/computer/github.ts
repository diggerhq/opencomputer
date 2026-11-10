// GitHub for the computer (work 052, decision 9): tokens are minted from the
// organization's managed GitHub App installations (work 028), and the
// computer's repositories are the ones those installations grant. Pure: the
// Durable Object fetches installations and repositories and mints through
// AccountDurableObject.

import type { WorkspaceDefinition, WorkspaceRepo } from "./protocol.js";

export interface ComputerInstallation {
  /** bluecode's connection id for the installation. */
  id: string;
  accountLogin: string;
}

export interface ComputerRepository {
  installationId: string;
  /** `owner/name`. */
  fullName: string;
  defaultBranch: string;
  archived: boolean;
  description?: string;
  language?: string;
  /** ISO time of the last push. */
  pushedAt?: string;
}

export type TokenTarget =
  | { ok: true; installationId: string; repositories?: string[] }
  | { ok: false; error: string };

/**
 * Which installation a token for `repos` (`owner/name` as git's credential
 * helper sends them, or a bare name) comes from, narrowed to those
 * repositories. A token covers one installation, so every repository must
 * belong to the same one. Without repositories (the `gh` shim), the
 * organization's only installation, or its first by account name when it has
 * several, unnarrowed.
 */
export function selectTokenTarget(
  repos: string[] | undefined,
  installations: ComputerInstallation[],
  repositories: ComputerRepository[],
): TokenTarget {
  if (!installations.length) {
    return { ok: false, error: "GitHub is not connected for this organization; connect it on the Computer page" };
  }
  const wanted = [...new Set((repos ?? []).map((repo) => repo.trim().replace(/\.git$/, "")).filter(Boolean))];
  if (!wanted.length) {
    const first = [...installations].sort((a, b) => a.accountLogin.localeCompare(b.accountLogin))[0]!;
    return { ok: true, installationId: first.id };
  }
  const byLogin = new Map(installations.map((installation) => [installation.accountLogin.toLowerCase(), installation]));
  const chosen = new Set<string>();
  const names: string[] = [];
  for (const repo of wanted) {
    const [owner, name] = repo.includes("/") ? repo.split("/", 2) : [undefined, repo];
    if (!name) return { ok: false, error: `invalid repository ${repo}` };
    let installation = owner ? byLogin.get(owner.toLowerCase()) : undefined;
    if (!owner) {
      const matches = repositories.filter((r) => r.fullName.split("/")[1]?.toLowerCase() === name.toLowerCase());
      if (matches.length === 1) installation = installations.find((i) => i.id === matches[0]!.installationId);
      else if (matches.length > 1) return { ok: false, error: `repository name ${name} is ambiguous; use owner/name` };
    }
    if (!installation) {
      const owners = installations.map((i) => i.accountLogin).sort().join(", ");
      return {
        ok: false,
        error: `${repo} is not in a GitHub account connected to this organization (connected: ${owners}); install the OpenComputer GitHub App there`,
      };
    }
    chosen.add(installation.id);
    names.push(name);
  }
  if (chosen.size > 1) {
    return { ok: false, error: `repositories ${wanted.join(", ")} belong to different GitHub accounts; ask for one account's at a time` };
  }
  return { ok: true, installationId: [...chosen][0]!, repositories: [...new Set(names)].sort() };
}

/** At most this many repositories are listed on the computer, the most recently pushed. */
export const DEFINITION_REPO_LIMIT = 100;
/** The most recently pushed repositories are cloned eagerly, in the background; the rest when a session checks them out. */
export const EAGER_REPO_COUNT = 3;

/**
 * The organization's workspace definition for `welcome` (calvin
 * WorkspaceDefinition, the shape of definitions/opencomputer.json): one repo
 * per accessible, unarchived repository; names that clash across owners
 * become `owner-name`. No setup commands. The root AGENTS.md is Calvin's
 * generic one for customer computers.
 *
 * Cloning (Calvin work 056): no session waits on a clone. The EAGER_REPO_COUNT
 * most recently pushed are cloned in the background as soon as the computer
 * gets the definition (GitHub connected), usually before the first mention;
 * the rest are `lazy`, cloned when a session checks them out. Description,
 * language and last push go to the repository index in each session's
 * AGENTS.md, so the model knows every repository without a clone.
 */
export function workspaceDefinition(name: string, repositories: ComputerRepository[]): WorkspaceDefinition {
  const byPush = repositories
    .filter((repository) => !repository.archived && /^[^/]+\/[^/]+$/.test(repository.fullName))
    // By push day, then name: the eager set and the cut stay put through a day of pushes (each change re-sends the definition).
    .sort((a, b) => pushDay(b).localeCompare(pushDay(a)) || a.fullName.localeCompare(b.fullName))
    .slice(0, DEFINITION_REPO_LIMIT);
  const eager = new Set(byPush.slice(0, EAGER_REPO_COUNT).map((repository) => repository.fullName));
  const live = byPush.sort((a, b) => a.fullName.localeCompare(b.fullName));
  const counts = new Map<string, number>();
  for (const repository of live) {
    const repoName = repository.fullName.split("/")[1]!.toLowerCase();
    counts.set(repoName, (counts.get(repoName) ?? 0) + 1);
  }
  const repos: WorkspaceRepo[] = live.map((repository) => {
    const [owner, repoName] = repository.fullName.split("/") as [string, string];
    const clash = (counts.get(repoName.toLowerCase()) ?? 0) > 1;
    return {
      name: sanitizeRepoName(clash ? `${owner}-${repoName}` : repoName),
      remote: `https://github.com/${owner}/${repoName}`,
      ...(repository.defaultBranch ? { branch: repository.defaultBranch } : {}),
      ...(eager.has(repository.fullName) ? {} : { clone: "lazy" as const }),
      ...(repository.description ? { description: repository.description } : {}),
      ...(repository.language ? { language: repository.language } : {}),
      // The day only: the definition changes (and the computer runs housekeeping) once a day per repository, not per push.
      ...(repository.pushedAt ? { pushedAt: pushDay(repository) } : {}),
    };
  });
  return {
    name: sanitizeRepoName(name) || "organization",
    about: "Your organization's repositories, from the GitHub accounts connected to OpenComputer.",
    repos,
    rootFiles: { "AGENTS.md": "computer/AGENTS.md" },
  };
}

const pushDay = (repository: ComputerRepository) => repository.pushedAt?.slice(0, 10) ?? "";

/** Calvin's repo names: `^[A-Za-z0-9][A-Za-z0-9._-]*$`. */
function sanitizeRepoName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
}
