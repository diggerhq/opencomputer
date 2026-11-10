/**
 * The automations repository (work 067): each
 * organization gets one Code.Storage repository holding its automations, a
 * folder each. Deploys stay as they are; after an organization's computer
 * deploys an automation it pushes the commit here, and people push with
 * `opencomputer push`, so the organization keeps the code of what it runs.
 * The repository is created on the first credential asked for.
 */
import {
  automationRepoId,
  ensureAutomationRepository,
  repositoryGitCredential,
} from "../templates/code-storage.js";
import { codeStorageConfigurationFromEnv, type TemplateEnv } from "./template-service.js";

/** As long as the computer's OpenComputer key. */
const CREDENTIAL_TTL_SECONDS = 60 * 60;

export type AutomationRepositoryEnv = Pick<
  TemplateEnv,
  | "SERVERLESS_AGENTS_DB"
  | "CODE_STORAGE_ORG"
  | "PIERRE_PRIVATE_KEY"
  | "CODE_STORAGE_API_BASE_URL"
  | "CODE_STORAGE_STORAGE_BASE_URL"
>;

export interface AutomationRepositoryCredential {
  remoteUrl: string;
  username: string;
  password: string;
  expiresAt: string;
}

/** The organization's automations repository, or null before anything asked for one. */
export async function automationRepository(
  env: Pick<AutomationRepositoryEnv, "SERVERLESS_AGENTS_DB">,
  accountId: string,
): Promise<string | null> {
  const row = await env.SERVERLESS_AGENTS_DB.prepare(
    "SELECT repo_id FROM automation_repositories WHERE account_id = ?",
  )
    .bind(accountId)
    .first<{ repo_id: string }>();
  return row?.repo_id ?? null;
}

/**
 * A one-hour read-write git credential for the organization's automations
 * repository, creating the repository on first ask. `userId` is who asked
 * first: a user, or `computer` for the organization's computer.
 */
export async function automationRepositoryCredential(
  env: AutomationRepositoryEnv,
  input: { accountId: string; userId: string },
): Promise<AutomationRepositoryCredential> {
  const configuration = codeStorageConfigurationFromEnv(env);
  if (!configuration) throw new Error("Automation repositories are not configured on this gateway");
  let repoId = await automationRepository(env, input.accountId);
  if (!repoId) {
    repoId = automationRepoId(input.accountId);
    await ensureAutomationRepository({ repoId, configuration });
    await env.SERVERLESS_AGENTS_DB.prepare(
      `INSERT INTO automation_repositories (account_id, repo_id, created_by, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id) DO NOTHING`,
    )
      .bind(input.accountId, repoId, input.userId, new Date().toISOString())
      .run();
  }
  return repositoryGitCredential({
    repoId,
    configuration,
    write: true,
    ttlSeconds: CREDENTIAL_TTL_SECONDS,
  });
}
