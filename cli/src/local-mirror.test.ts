import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { provisionLocalRepositories } from "./local-mirror.js";

const execFileAsync = promisify(execFile);
const commitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: "OpenComputer Test",
  GIT_AUTHOR_EMAIL: "test@opencomputer.local",
  GIT_COMMITTER_NAME: "OpenComputer Test",
  GIT_COMMITTER_EMAIL: "test@opencomputer.local",
};

test("local repository mirrors use the local Git client and expose only the mirror remote", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-local-mirror-"));
  const upstream = resolve(root, "upstream.git");
  const source = resolve(root, "source");
  const agentRoot = resolve(root, "agent");
  const runtime = resolve(agentRoot, ".opencomputer", "runtime");
  try {
    await execFileAsync("git", ["init", "--bare", upstream]);
    await execFileAsync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
      cwd: upstream,
    });
    await execFileAsync("git", ["init", source]);
    await writeFile(resolve(source, "flags.json"), '{"checkout-v2":true}\n');
    await execFileAsync("git", ["add", "flags.json"], { cwd: source });
    await execFileAsync("git", ["commit", "-m", "seed"], {
      cwd: source,
      env: commitEnvironment,
    });
    await execFileAsync("git", ["push", upstream, "HEAD:refs/heads/main"], {
      cwd: source,
    });
    await mkdir(resolve(runtime, ".opencomputer"), { recursive: true });
    await writeFile(
      resolve(runtime, ".opencomputer", "reactive.json"),
      `${JSON.stringify({
        repositories: [
          {
            id: "application",
            source: {
              provider: "github",
              owner: "diggerhq",
              name: "opencomputer-example-unleash",
              auth: "auto",
            },
            mirror: { mode: "managed", sync: "pull" },
            workspace: {
              path: "repositories/application",
              access: "read-write",
              refs: "session",
            },
            publish: { mode: "actions-only" },
          },
        ],
      })}\n`,
    );

    const [repository] = await provisionLocalRepositories(agentRoot, runtime, {
      sourceURL: () => upstream,
      sessionRef: "opencomputer/sessions/test-session",
    });
    assert.ok(repository);
    assert.equal(repository.defaultBranch, "main");
    assert.equal(repository.sessionBranch, "opencomputer/sessions/test-session");
    assert.equal(
      await readFile(resolve(repository.checkout, "flags.json"), "utf8"),
      '{"checkout-v2":true}\n',
    );
    const { stdout: origin } = await execFileAsync(
      "git",
      ["remote", "get-url", "origin"],
      { cwd: repository.checkout },
    );
    assert.equal(origin.trim(), repository.mirror);

    await writeFile(resolve(repository.checkout, "flags.json"), "{}\n");
    await execFileAsync("git", ["add", "flags.json"], {
      cwd: repository.checkout,
    });
    await execFileAsync("git", ["commit", "-m", "remove stale flag"], {
      cwd: repository.checkout,
      env: commitEnvironment,
    });
    await execFileAsync("git", ["push", "-u", "origin", "HEAD"], {
      cwd: repository.checkout,
    });
    const { stdout: checkoutHead } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: repository.checkout },
    );
    const { stdout: mirrorHead } = await execFileAsync(
      "git",
      ["rev-parse", "refs/heads/opencomputer/sessions/test-session"],
      { cwd: repository.mirror },
    );
    assert.equal(mirrorHead.trim(), checkoutHead.trim());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
