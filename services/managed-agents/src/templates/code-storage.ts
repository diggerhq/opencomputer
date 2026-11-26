import { createHash } from "node:crypto";
import { GitStorage, type Repo } from "@pierre/storage";

export interface TemplateRepositoryIdentity {
  owner: string;
  name: string;
  fullName: string;
  url: string;
}

export interface MirroredTemplateSource extends TemplateRepositoryIdentity {
  mirrorRepoId: string;
  commitSha: string;
  repository: Repo;
}

export interface CodeStorageConfiguration {
  organization: string;
  privateKey: string;
  apiBaseUrl?: string;
  storageBaseUrl?: string;
}

export function parsePublicGitHubRepository(
  value: string,
): TemplateRepositoryIdentity {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Template repository must be https://github.com/<owner>/<repository>",
    );
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    parts.length !== 2 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(parts[0]!) ||
    !/^[A-Za-z0-9._-]+$/.test(parts[1]!) ||
    parts[1]!.endsWith(".git")
  ) {
    throw new Error(
      "Template repository must be a root GitHub HTTPS URL without a ref or query",
    );
  }
  const owner = parts[0]!;
  const name = parts[1]!;
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}`,
  };
}

export function templateMirrorRepoId(fullName: string): string {
  return `template-${createHash("sha256").update(fullName.toLowerCase()).digest("hex").slice(0, 24)}`;
}

export function templateProjectRepoId(installationId: string): string {
  const normalized = installationId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!normalized) throw new Error("Installation ID cannot name a repository");
  return `project-${normalized}`;
}

function client(configuration: CodeStorageConfiguration): GitStorage {
  return new GitStorage({
    name: configuration.organization,
    key: configuration.privateKey,
    ...(configuration.apiBaseUrl
      ? { apiBaseUrl: configuration.apiBaseUrl }
      : {}),
    ...(configuration.storageBaseUrl
      ? { storageBaseUrl: configuration.storageBaseUrl }
      : {}),
  });
}

export async function projectRepositoryArchive(input: {
  projectRepoId: string;
  configuration: CodeStorageConfiguration;
}): Promise<Response> {
  const repository = client(input.configuration).repo({
    id: input.projectRepoId,
    defaultBranch: "main",
  });
  return repository.getArchiveStream({
    ref: "main",
    archivePrefix: "",
    ttl: 60,
  });
}

async function ensurePublicMirror(
  storage: GitStorage,
  identity: TemplateRepositoryIdentity,
): Promise<Repo> {
  const id = templateMirrorRepoId(identity.fullName);
  const existing = await storage.findOne({ id });
  if (existing) {
    if (existing.defaultBranch !== "main") {
      throw new Error("The template mirror default branch is not main");
    }
    await existing.pullUpstream();
    return existing;
  }
  const created = await storage.createRepo({
    id,
    defaultBranch: "main",
    baseRepo: {
      provider: "github",
      owner: identity.owner,
      name: identity.name,
      defaultBranch: "main",
      auth: { authType: "public" },
    },
  });
  await created.pullUpstream();
  return created;
}

/**
 * The current upstream HEAD of a template's mirror, or null when the mirror
 * does not exist yet or its HEAD cannot be resolved. Pulling upstream is a
 * metadata fetch on the storage side, so this stays cheap per call.
 */
export async function templateMirrorHeadSha(
  fullName: string,
  configuration: CodeStorageConfiguration,
): Promise<string | null> {
  const storage = client(configuration);
  const repository = await storage.findOne({
    id: templateMirrorRepoId(fullName),
  });
  if (!repository || repository.defaultBranch !== "main") return null;
  await repository.pullUpstream();
  const head = (await repository.listCommits({ branch: "main", limit: 1 }))
    .commits[0];
  return head && /^[0-9a-f]{40}$/i.test(head.sha)
    ? head.sha.toLowerCase()
    : null;
}

export async function mirrorPublicTemplate(
  repositoryUrl: string,
  configuration: CodeStorageConfiguration,
): Promise<MirroredTemplateSource> {
  const identity = parsePublicGitHubRepository(repositoryUrl);
  const repository = await ensurePublicMirror(client(configuration), identity);
  const head = (await repository.listCommits({ branch: "main", limit: 1 }))
    .commits[0];
  if (!head || !/^[0-9a-f]{40}$/i.test(head.sha)) {
    throw new Error("Code.Storage did not resolve a valid main commit");
  }
  return {
    ...identity,
    mirrorRepoId: repository.id,
    commitSha: head.sha.toLowerCase(),
    repository,
  };
}

export async function forkTemplateForProject(input: {
  mirrorRepoId: string;
  commitSha: string;
  installationId: string;
  configuration: CodeStorageConfiguration;
}): Promise<{ projectRepoId: string }> {
  if (!/^[0-9a-f]{40}$/.test(input.commitSha)) {
    throw new Error("Template fork requires an immutable commit SHA");
  }
  const storage = client(input.configuration);
  const projectRepoId = templateProjectRepoId(input.installationId);
  const existing = await storage.findOne({ id: projectRepoId });
  if (!existing) {
    await storage.createRepo({
      id: projectRepoId,
      defaultBranch: "main",
      baseRepo: {
        id: input.mirrorRepoId,
        sha: input.commitSha,
      },
    });
  }
  return { projectRepoId };
}

/** An organization's automations repository (work 067). */
export function automationRepoId(accountId: string): string {
  const normalized = accountId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!normalized) throw new Error("Account ID cannot name a repository");
  return `automations-${normalized}`;
}

/** Creates the automation repository on first use; an empty repository until the first push. */
export async function ensureAutomationRepository(input: {
  repoId: string;
  configuration: CodeStorageConfiguration;
}): Promise<void> {
  const storage = client(input.configuration);
  if (await storage.findOne({ id: input.repoId })) return;
  await storage.createRepo({ id: input.repoId, defaultBranch: "main" });
}

/**
 * A short-lived git credential for one repository, split from the remote URL
 * the SDK mints so the URL can be configured once and the credential handed
 * out per request: Code.Storage takes it as HTTP basic auth, user `t`.
 */
export async function repositoryGitCredential(input: {
  repoId: string;
  configuration: CodeStorageConfiguration;
  write: boolean;
  ttlSeconds: number;
}): Promise<{ remoteUrl: string; username: string; password: string; expiresAt: string }> {
  const minted = new URL(
    await client(input.configuration)
      .repo({ id: input.repoId, defaultBranch: "main" })
      .getRemoteURL({
        permissions: input.write ? ["git:read", "git:write"] : ["git:read"],
        ttl: input.ttlSeconds,
      }),
  );
  const username = decodeURIComponent(minted.username);
  const password = decodeURIComponent(minted.password);
  minted.username = "";
  minted.password = "";
  return {
    remoteUrl: minted.toString(),
    username,
    password,
    expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
  };
}
