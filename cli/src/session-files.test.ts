import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { APIError, type WorkspaceArtifact, type WorkspaceFile } from "./api.js";
import {
  VerificationError,
  downloadWorkspace,
  downloadWorkspaceFile,
  formatSize,
  localPathFor,
  normalizeWorkspacePath,
  resolveSingleDestination,
  type WorkspaceClient,
} from "./session-files.js";

const sessionId = "ses-1";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type Fixture = { path: string; bytes: Uint8Array; served?: Uint8Array };

function fakeClient(fixtures: Fixture[]): WorkspaceClient & {
  exports: string[];
} {
  const byPath = new Map(fixtures.map((fixture) => [fixture.path, fixture]));
  const files: WorkspaceFile[] = fixtures.map((fixture, index) => ({
    path: fixture.path,
    size: fixture.bytes.length,
    lastModified: "2026-01-01T00:00:00.000Z",
    etag: `etag-${index}`,
  }));
  const exports: string[] = [];
  const artifactFor = (fixture: Fixture): WorkspaceArtifact => ({
    id: `art-${fixture.path}`,
    sessionId,
    path: fixture.path,
    size: fixture.bytes.length,
    sha256: sha256(fixture.bytes),
    receipt: { etag: null, sourceEtag: null, sourceVersionId: null },
    exportedAt: "2026-01-01T00:00:00.000Z",
  });
  return {
    exports,
    async workspaceFiles() {
      return files;
    },
    async workspaceArtifacts() {
      return fixtures.map(artifactFor);
    },
    async exportWorkspaceFile(_session, filePath) {
      const fixture = byPath.get(filePath);
      if (!fixture) throw new Error(`no such file ${filePath}`);
      exports.push(filePath);
      return artifactFor(fixture);
    },
    async workspaceArtifactContent(artifact) {
      const fixture = fixtures.find((f) => `art-${f.path}` === artifact.id);
      if (!fixture) throw new Error("unknown artifact");
      const body = fixture.served ?? fixture.bytes;
      return new Response(new Uint8Array(body), {
        headers: { "content-type": "application/octet-stream" },
      });
    },
  };
}

async function withDirectory<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "oc-files-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("normalizeWorkspacePath accepts /workspace-prefixed and relative paths", () => {
  assert.equal(
    normalizeWorkspacePath("/workspace/out/report.pdf"),
    "out/report.pdf",
  );
  assert.equal(normalizeWorkspacePath("out/report.pdf"), "out/report.pdf");
  assert.equal(normalizeWorkspacePath("/my file.txt"), "my file.txt");
  assert.equal(normalizeWorkspacePath(" padded .txt "), " padded .txt ");
  for (const bad of [
    "../etc/passwd",
    "a/../b",
    "./a",
    "a//b",
    "",
    "/workspace",
  ]) {
    assert.throws(() => normalizeWorkspacePath(bad));
  }
});

test("localPathFor never escapes the destination root", () => {
  const root = path.resolve("dest");
  assert.equal(localPathFor(root, "a/b.txt"), path.join(root, "a", "b.txt"));
  assert.equal(localPathFor(root, "..settings"), path.join(root, "..settings"));
  assert.throws(() => localPathFor(root, "../x"), /outside/);
  assert.throws(() => localPathFor(root, "a/../../x"), /outside/);
});

test("download exports first, then saves the verified bytes", async () => {
  const bytes = new TextEncoder().encode("hello evidence");
  const client = fakeClient([{ path: "out/a.txt", bytes }]);
  await withDirectory(async (dir) => {
    const destination = path.join(dir, "a.txt");
    const result = await downloadWorkspaceFile(
      client,
      sessionId,
      "out/a.txt",
      destination,
    );
    assert.deepEqual(client.exports, ["out/a.txt"]);
    assert.equal(result.size, bytes.length);
    assert.equal(result.sha256, sha256(bytes));
    assert.equal(await readFile(destination, "utf8"), "hello evidence");
    assert.deepEqual(await readdir(dir), ["a.txt"]);
  });
});

for (const [name, served] of [
  ["corrupted", new TextEncoder().encode("hello EVIDENCE")],
  ["truncated", new TextEncoder().encode("hello")],
  ["oversized", new TextEncoder().encode("hello evidence and more")],
] as const) {
  test(`${name} content is rejected and leaves nothing on disk`, async () => {
    const bytes = new TextEncoder().encode("hello evidence");
    const client = fakeClient([{ path: "a.txt", bytes, served }]);
    await withDirectory(async (dir) => {
      const destination = path.join(dir, "a.txt");
      await assert.rejects(
        downloadWorkspaceFile(client, sessionId, "a.txt", destination),
        VerificationError,
      );
      assert.deepEqual(await readdir(dir), []);
    });
  });
}

test("--all mirrors the workspace layout under the destination", async () => {
  const client = fakeClient([
    { path: "b/deep/two.bin", bytes: new Uint8Array([1, 2, 3]) },
    { path: "one.txt", bytes: new TextEncoder().encode("one") },
  ]);
  await withDirectory(async (dir) => {
    const results = await downloadWorkspace(client, sessionId, dir);
    assert.deepEqual(
      results.map((result) => result.path),
      ["b/deep/two.bin", "one.txt"],
    );
    assert.deepEqual(
      await readFile(path.join(dir, "b", "deep", "two.bin")),
      Buffer.from([1, 2, 3]),
    );
    assert.equal(await readFile(path.join(dir, "one.txt"), "utf8"), "one");
  });
});

test("an ended session falls back to its retained artifacts", async () => {
  const bytes = new TextEncoder().encode("kept");
  const base = fakeClient([{ path: "kept.txt", bytes }]);
  const gone = () =>
    Promise.reject(
      new APIError("workspace gone", 410, "workspace_unavailable"),
    );
  const client: WorkspaceClient = {
    ...base,
    workspaceFiles: gone,
    exportWorkspaceFile: gone,
  };
  await withDirectory(async (dir) => {
    const single = await downloadWorkspaceFile(
      client,
      sessionId,
      "kept.txt",
      path.join(dir, "single.txt"),
    );
    assert.equal(single.artifactId, "art-kept.txt");
    assert.equal(await readFile(path.join(dir, "single.txt"), "utf8"), "kept");
    const all = await downloadWorkspace(
      client,
      sessionId,
      path.join(dir, "all"),
    );
    assert.deepEqual(
      all.map((result) => result.path),
      ["kept.txt"],
    );
    await assert.rejects(
      downloadWorkspaceFile(
        client,
        sessionId,
        "never.txt",
        path.join(dir, "n"),
      ),
      (error: unknown) =>
        error instanceof APIError && error.code === "workspace_unavailable",
    );
  });
});

test("--all refuses to follow a symlinked directory out of the root", async () => {
  const client = fakeClient([
    { path: "link/escaped.txt", bytes: new TextEncoder().encode("x") },
  ]);
  await withDirectory(async (dir) => {
    const root = path.join(dir, "root");
    const outside = path.join(dir, "outside");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, path.join(root, "link"));
    await assert.rejects(downloadWorkspace(client, sessionId, root), /outside/);
    assert.deepEqual(await readdir(outside), []);
  });
});

test("resolveSingleDestination follows cp semantics", async () => {
  await withDirectory(async (dir) => {
    assert.equal(
      await resolveSingleDestination(dir, "out/report.pdf"),
      path.join(dir, "report.pdf"),
    );
    assert.equal(
      await resolveSingleDestination(`${dir}${path.sep}`, "x.txt"),
      path.join(dir, "x.txt"),
    );
    assert.equal(
      await resolveSingleDestination(
        path.join(dir, "renamed.pdf"),
        "out/report.pdf",
      ),
      path.join(dir, "renamed.pdf"),
    );
    assert.equal(
      await resolveSingleDestination(undefined, "out/report.pdf"),
      path.resolve("report.pdf"),
    );
  });
});

test("formatSize is human readable", () => {
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(1536), "1.5 KiB");
  assert.equal(formatSize(3 * 1024 * 1024), "3.0 MiB");
});
