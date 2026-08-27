import { spawn } from "node:child_process";

export type ActionRecordKind = "requests" | "decisions" | "results";

function refComponent(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Action ID is not a valid Git ref component");
  }
  return value;
}

function actionRef(kind: ActionRecordKind, actionId: string): string {
  return `refs/opencomputer/${kind}/${refComponent(actionId)}`;
}

async function git(
  cwd: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(`git ${args[0] ?? ""} failed: ${stderr.trim()}`));
    });
    child.stdin.end(options.input);
  });
}

export class GitActionLedger {
  constructor(
    readonly repository: string,
    readonly remote = "origin",
  ) {}

  async read<T>(
    kind: ActionRecordKind,
    actionId: string,
  ): Promise<{ oid: string; record: T } | undefined> {
    const ref = actionRef(kind, actionId);
    const advertised = await git(this.repository, [
      "ls-remote",
      "--refs",
      this.remote,
      ref,
    ]);
    if (!advertised) return undefined;
    const oid = advertised.split(/\s+/)[0];
    if (!oid) throw new Error(`Remote returned an invalid ref for ${ref}`);
    await git(this.repository, [
      "fetch",
      "--quiet",
      this.remote,
      `${ref}:${ref}`,
    ]);
    const body = await git(this.repository, ["show", `${oid}:record.json`]);
    return { oid, record: JSON.parse(body) as T };
  }

  async write<T>(
    kind: ActionRecordKind,
    actionId: string,
    record: T,
    options: { parent?: string; message?: string } = {},
  ): Promise<{ oid: string; record: T }> {
    const ref = actionRef(kind, actionId);
    if (await this.read(kind, actionId)) throw new Error(`${ref} already exists`);
    const blob = await git(this.repository, ["hash-object", "-w", "--stdin"], {
      input: `${JSON.stringify(record, null, 2)}\n`,
    });
    const tree = await git(this.repository, ["mktree"], {
      input: `100644 blob ${blob}\trecord.json\n`,
    });
    const args = ["commit-tree", tree];
    if (options.parent) args.push("-p", options.parent);
    args.push("-m", options.message ?? `${kind}: ${actionId}`);
    const oid = await git(this.repository, args, {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "OpenComputer Actions",
        GIT_AUTHOR_EMAIL: "actions@opencomputer.local",
        GIT_COMMITTER_NAME: "OpenComputer Actions",
        GIT_COMMITTER_EMAIL: "actions@opencomputer.local",
      },
    });
    await git(this.repository, ["push", "--quiet", this.remote, `${oid}:${ref}`]);
    return { oid, record };
  }

  async list(kind: ActionRecordKind): Promise<string[]> {
    const prefix = `refs/opencomputer/${kind}/`;
    const output = await git(this.repository, [
      "ls-remote",
      "--refs",
      this.remote,
      `${prefix}*`,
    ]);
    if (!output) return [];
    return output.split("\n").map((line) => {
      const ref = line.trim().split(/\s+/)[1];
      if (!ref?.startsWith(prefix)) throw new Error("Remote returned an invalid action ref");
      return ref.slice(prefix.length);
    });
  }

  async waitFor<T>(
    kind: ActionRecordKind,
    actionId: string,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ oid: string; record: T }> {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      const found = await this.read<T>(kind, actionId);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 50));
    }
    throw new Error(`Timed out waiting for ${actionRef(kind, actionId)}`);
  }
}
