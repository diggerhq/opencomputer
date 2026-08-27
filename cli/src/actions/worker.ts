import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { GitActionLedger } from "./git-ledger.js";
import type { ActionPolicyEvaluator } from "./policy.js";
import type {
  ActionDecisionRecord,
  ActionRequestRecord,
  ActionResultRecord,
  CompiledActionDefinition,
  DataValue,
} from "./protocol.js";

export interface ResolvedSecret {
  value: string;
  version: string;
}

export interface ActionSecretProvider {
  resolve(input: {
    projectId: string;
    environment: string;
    name: string;
    actionId: string;
    requestOid: string;
  }): Promise<ResolvedSecret>;
}

export interface IsolatedExecutor {
  execute(input: {
    entry: string;
    definitionId: string;
    actionId: string;
    requestOid: string;
    actionInput: Record<string, DataValue>;
    secrets: Record<string, string>;
    repositories: Record<
      string,
      { id: string; remote: string; defaultBranch: string }
    >;
  }): Promise<DataValue>;
}

export interface ActionRepositoryProvider {
  resolve(id: string): Promise<{
    id: string;
    remote: string;
    defaultBranch: string;
  }>;
}

export class ChildProcessActionExecutor implements IsolatedExecutor {
  constructor(
    private readonly childEntry = resolve(
      import.meta.dirname,
      "executor-child.js",
    ),
    private readonly timeoutMs = 60_000,
  ) {}

  async execute(input: {
    entry: string;
    definitionId: string;
    actionId: string;
    requestOid: string;
    actionInput: Record<string, DataValue>;
    secrets: Record<string, string>;
    repositories: Record<
      string,
      { id: string; remote: string; defaultBranch: string }
    >;
  }): Promise<DataValue> {
    return new Promise<DataValue>((resolvePromise, reject) => {
      const childArguments = this.childEntry.endsWith(".ts")
        ? ["--import", "tsx", this.childEntry]
        : [this.childEntry];
      const child = spawn(process.execPath, childArguments, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "",
          TMPDIR: process.env.TMPDIR ?? "/tmp",
          LANG: process.env.LANG ?? "C",
        } as unknown as NodeJS.ProcessEnv,
      });
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Action executor timed out"));
      }, this.timeoutMs);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        try {
          const line = stdout.trim().split("\n").at(-1);
          const result = JSON.parse(line ?? "") as
            | { ok: true; output: DataValue }
            | { ok: false; error: string };
          if (!result.ok) throw new Error(result.error);
          resolvePromise(result.output);
        } catch (error) {
          reject(
            error instanceof Error
              ? new Error(`${error.message}${stderr ? `: ${stderr}` : ""}`)
              : error,
          );
        }
      });
      child.stdin.end(
        JSON.stringify({
          entry: input.entry,
          definitionId: input.definitionId,
          actionId: input.actionId,
          requestOid: input.requestOid,
          input: input.actionInput,
          secrets: input.secrets,
          repositories: input.repositories,
        }),
      );
    });
  }
}

export class LocalActionWorker {
  constructor(
    private readonly ledger: GitActionLedger,
    private readonly bundleEntry: string,
    definitions: CompiledActionDefinition[],
    private readonly policyBundleDigest: string,
    private readonly policyEvaluator: ActionPolicyEvaluator,
    private readonly secretProvider: ActionSecretProvider,
    private readonly executor: IsolatedExecutor,
    private readonly repositoryProvider?: ActionRepositoryProvider,
  ) {
    this.definitions = new Map(
      definitions.map((definition) => [definition.id, definition]),
    );
  }

  private readonly definitions: Map<string, CompiledActionDefinition>;

  async process(actionId: string): Promise<ActionResultRecord> {
    const existing = await this.ledger.read<ActionResultRecord>("results", actionId);
    if (existing) return existing.record;
    const requestEntry = await this.ledger.read<ActionRequestRecord>("requests", actionId);
    if (!requestEntry) throw new Error(`Action request ${actionId} does not exist`);
    const definition = this.definitions.get(requestEntry.record.definitionId);
    if (!definition) {
      throw new Error(`Action definition ${requestEntry.record.definitionId} does not exist`);
    }
    let decisionEntry = await this.ledger.read<ActionDecisionRecord>(
      "decisions",
      actionId,
    );
    if (!decisionEntry) {
      const disposition = await this.policyEvaluator.evaluate({
        entry: this.bundleEntry,
        request: requestEntry.record,
      });
      decisionEntry = await this.ledger.write<ActionDecisionRecord>(
        "decisions",
        actionId,
        {
          schemaVersion: 1,
          actionId,
          requestOid: requestEntry.oid,
          policyBundleDigest: this.policyBundleDigest,
          decidedAt: new Date().toISOString(),
          disposition,
        },
        { parent: requestEntry.oid, message: `decision: ${disposition.action}` },
      );
    }

    const secretVersions: ActionResultRecord["secretVersions"] = [];
    let outcome: ActionResultRecord["outcome"];
    if (decisionEntry.record.disposition.action === "allow") {
      try {
        const secrets: Record<string, string> = {};
        for (const [alias, name] of Object.entries(definition.secrets)) {
          const resolvedSecret = await this.secretProvider.resolve({
            projectId: requestEntry.record.projectId,
            environment: requestEntry.record.environment,
            name,
            actionId,
            requestOid: requestEntry.oid,
          });
          secrets[alias] = resolvedSecret.value;
          secretVersions.push({ alias, name, version: resolvedSecret.version });
        }
        const output = await this.executor.execute({
          entry: this.bundleEntry,
          definitionId: definition.id,
          actionId,
          requestOid: requestEntry.oid,
          actionInput: requestEntry.record.input,
          secrets,
          repositories:
            typeof requestEntry.record.input.repositoryId === "string" &&
            this.repositoryProvider
              ? {
                  [requestEntry.record.input.repositoryId]:
                    await this.repositoryProvider.resolve(
                      requestEntry.record.input.repositoryId,
                    ),
                }
              : {},
        });
        outcome = { status: "succeeded", output };
      } catch (error) {
        outcome = {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } else if (decisionEntry.record.disposition.action === "deny") {
      outcome = {
        status: "denied",
        reason: decisionEntry.record.disposition.reason,
      };
    } else {
      outcome = {
        status: "pending",
        reason: decisionEntry.record.disposition.action,
      };
    }
    return (
      await this.ledger.write<ActionResultRecord>(
        "results",
        actionId,
        {
          schemaVersion: 1,
          actionId,
          requestOid: requestEntry.oid,
          decisionOid: decisionEntry.oid,
          completedAt: new Date().toISOString(),
          secretVersions,
          outcome,
        },
        { parent: decisionEntry.oid, message: `result: ${outcome.status}` },
      )
    ).record;
  }

  async processPending(): Promise<void> {
    const requests = await this.ledger.list("requests");
    const results = new Set(await this.ledger.list("results"));
    for (const actionId of requests) {
      if (!results.has(actionId)) await this.process(actionId);
    }
  }
}
