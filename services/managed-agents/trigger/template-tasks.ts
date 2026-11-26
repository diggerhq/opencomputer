import { AbortTaskRunError, task } from "@trigger.dev/sdk";

import {
  forkTemplateForProject,
  mirrorPublicTemplate,
  type CodeStorageConfiguration,
} from "../src/templates/code-storage.js";
import { templateTaskRequest } from "../src/templates/internal-api.js";
import {
  buildGitCommit,
  buildMirroredTemplate,
} from "../src/templates/trigger-builder.js";

// Template compilation is a code contract, not deployment configuration. Keep
// the production task on a reviewed, immutable compiler revision so a stale
// environment variable cannot silently remove supported authoring APIs.
const TEMPLATE_CLI_COMMIT = "c4e418f141930f1fa086005c33b9a8e64ecd405d";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function privateKey(name: string): string {
  return required(name).replace(/\\n/g, "\n");
}

function codeStorageConfiguration(): CodeStorageConfiguration {
  return {
    organization: required("CODE_STORAGE_ORG"),
    privateKey: privateKey("PIERRE_PRIVATE_KEY"),
    ...(process.env.CODE_STORAGE_API_BASE_URL
      ? { apiBaseUrl: process.env.CODE_STORAGE_API_BASE_URL }
      : {}),
    ...(process.env.CODE_STORAGE_STORAGE_BASE_URL
      ? { storageBaseUrl: process.env.CODE_STORAGE_STORAGE_BASE_URL }
      : {}),
  };
}

function internalApiConfiguration() {
  return {
    baseUrl: required("OPENCOMPUTER_TEMPLATE_API_URL"),
    secret: required("OPENCOMPUTER_TEMPLATE_TASK_SECRET"),
  };
}

function failureMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : "Template synchronization failed";
  return message.slice(0, 4_000);
}

function abortCompilerValidation(error: unknown): never {
  if (
    error instanceof Error &&
    (error.message.includes("failed: opencomputer:") ||
      error.message.includes("a newer build supersedes it") ||
      /^Build is (superseded|removed|failed|ready)$/.test(error.message) ||
      error.message.startsWith("The deployment source ") ||
      error.message === "Project is archived")
  ) {
    throw new AbortTaskRunError(error.message);
  }
  throw error;
}

function cliSource(): { repositoryUrl: string; commitSha: string } {
  return {
    repositoryUrl:
      process.env.OPENCOMPUTER_TEMPLATE_CLI_REPOSITORY ??
      "https://github.com/diggerhq/opencomputer.git",
    commitSha:
      process.env.OPENCOMPUTER_TEMPLATE_CLI_COMMIT ?? TEMPLATE_CLI_COMMIT,
  };
}

export const syncServerlessAgentTemplate = task({
  id: "sync-serverless-agent-template",
  machine: "medium-1x",
  maxDuration: 20 * 60,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
    randomize: true,
    outOfMemory: {
      machine: "medium-2x",
    },
  },
  onFailure: async ({ payload, error }) => {
    await templateTaskRequest(
      internalApiConfiguration(),
      `/internal/template-registrations/${encodeURIComponent(payload.registrationId)}/fail`,
      {
        method: "POST",
        body: JSON.stringify({ message: failureMessage(error) }),
      },
    );
  },
  run: async (payload: { registrationId: string; repositoryUrl: string }) => {
    const source = await mirrorPublicTemplate(
      payload.repositoryUrl,
      codeStorageConfiguration(),
    );
    const bundle = await buildMirroredTemplate({
      repository: source.repository,
      commitSha: source.commitSha,
      cliSource: cliSource(),
    }).catch(abortCompilerValidation);
    return templateTaskRequest(
      internalApiConfiguration(),
      `/internal/template-registrations/${encodeURIComponent(payload.registrationId)}/complete`,
      {
        method: "POST",
        body: JSON.stringify({
          repository: {
            url: source.url,
            fullName: source.fullName,
            defaultBranch: "main",
            commitSha: source.commitSha,
            mirrorRepoId: source.mirrorRepoId,
          },
          bundle,
        }),
      },
    );
  },
});

/**
 * Builds one commit of a project's connected GitHub repository (a push to the
 * deploy branch or a pull request head) and publishes it under the build's
 * alias: `development` for the branch, `pr-<n>` for previews.
 */
export const deployServerlessAgentGitBuild = task({
  id: "deploy-serverless-agent-git-build",
  machine: "medium-1x",
  maxDuration: 20 * 60,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
    randomize: true,
    outOfMemory: {
      machine: "medium-2x",
    },
  },
  onFailure: async ({ payload, error }) => {
    await templateTaskRequest(
      internalApiConfiguration(),
      `/internal/git-builds/${encodeURIComponent(payload.buildId)}/fail`,
      {
        method: "POST",
        body: JSON.stringify({ message: failureMessage(error) }),
      },
    );
  },
  run: async (payload: { buildId: string }) => {
    const plan = await templateTaskRequest<{
      repositoryUrl: string;
      ref: string;
      commitSha: string;
      path?: string | null;
      token: string;
    }>(
      internalApiConfiguration(),
      `/internal/git-builds/${encodeURIComponent(payload.buildId)}/plan`,
    ).catch(abortCompilerValidation);
    const bundle = await buildGitCommit({
      repositoryUrl: plan.repositoryUrl,
      token: plan.token,
      ref: plan.ref,
      commitSha: plan.commitSha,
      path: plan.path ?? undefined,
      cliSource: cliSource(),
    }).catch(abortCompilerValidation);
    return templateTaskRequest(
      internalApiConfiguration(),
      `/internal/git-builds/${encodeURIComponent(payload.buildId)}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ bundle }),
      },
    );
  },
});

export const installServerlessAgentTemplate = task({
  id: "install-serverless-agent-template",
  maxDuration: 10 * 60,
  retry: {
    maxAttempts: 4,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 20_000,
    factor: 2,
    randomize: true,
  },
  run: async (payload: { installationId: string }) => {
    const plan = await templateTaskRequest<{
      mirrorRepoId: string;
      commitSha: string;
    }>(
      internalApiConfiguration(),
      `/internal/template-installations/${encodeURIComponent(payload.installationId)}/plan`,
    );
    const fork = await forkTemplateForProject({
      ...plan,
      installationId: payload.installationId,
      configuration: codeStorageConfiguration(),
    });
    return templateTaskRequest(
      internalApiConfiguration(),
      `/internal/template-installations/${encodeURIComponent(payload.installationId)}/complete`,
      {
        method: "POST",
        body: JSON.stringify(fork),
      },
    );
  },
});
