import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  materializeTemplateSnapshot,
  prepareLinkedProjectSource,
} from "../src/templates/trigger-builder.js";

const SHA = "a".repeat(40);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function repository(
  files: Array<{
    path: string;
    content: string;
    type?: "blob" | "tree" | "symlink" | "submodule";
  }>,
) {
  const contents = new Map(files.map((file) => [file.path, file.content]));
  return {
    async listFilesWithMetadata() {
      return {
        files: files.map((file) => ({
          path: file.path,
          mode: "100644",
          size: Buffer.byteLength(file.content),
          lastCommitSha: SHA,
          ...(file.type ? { type: file.type } : {}),
        })),
        commits: {},
        ref: SHA,
        hasMore: false,
      };
    },
    async getFileStream({ path }: { path: string }) {
      const content = contents.get(path);
      return content == null
        ? new Response("missing", { status: 404 })
        : new Response(new TextEncoder().encode(content));
    },
  };
}

describe("Trigger template source materialization", () => {
  it("writes only commit-pinned regular Code.Storage files", async () => {
    const root = await mkdtemp(join(tmpdir(), "template-loader-test-"));
    roots.push(root);
    const source = repository([
      { path: "oc-template.toml", content: "schema = 1\n" },
      { path: "opencomputer/.env.example", content: "API_KEY=\n" },
      {
        path: "opencomputer/agents/hello/agent.ts",
        content: "export default function () {}\n",
        type: "blob",
      },
    ]);

    await materializeTemplateSnapshot(source, SHA, root);

    await expect(readFile(join(root, "oc-template.toml"), "utf8")).resolves.toBe(
      "schema = 1\n",
    );
    await expect(
      readFile(join(root, "opencomputer/agents/hello/agent.ts"), "utf8"),
    ).resolves.toContain("export default");
    await expect(
      readFile(join(root, "opencomputer/.env.example"), "utf8"),
    ).resolves.toBe("API_KEY=\n");
  });

  it.each([
    ["path escape", "../secret", undefined],
    ["backslash", "opencomputer\\project.ts", undefined],
    ["Git metadata", ".git/config", undefined],
    ["dependencies", "node_modules/package/index.js", undefined],
    ["environment file", ".env.production", undefined],
    ["local environment file", "opencomputer/.env.local", undefined],
    ["symlink", "opencomputer/project.ts", "symlink"],
    ["submodule", "vendor/runtime", "submodule"],
  ])("rejects %s", async (_name, path, type) => {
    const root = await mkdtemp(join(tmpdir(), "template-loader-test-"));
    roots.push(root);
    await expect(
      materializeTemplateSnapshot(
        repository([
          {
            path,
            content: "x",
            ...(type
              ? {
                  type: type as
                    | "blob"
                    | "tree"
                    | "symlink"
                    | "submodule",
                }
              : {}),
          },
        ]),
        SHA,
        root,
      ),
    ).rejects.toThrow();
  });

  it("rejects mutable refs", async () => {
    const root = await mkdtemp(join(tmpdir(), "template-loader-test-"));
    roots.push(root);
    await expect(
      materializeTemplateSnapshot(repository([]), "main", root),
    ).rejects.toThrow("immutable commit SHA");
  });

  it("rejects a response larger than Code.Storage metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "template-loader-test-"));
    roots.push(root);
    const source = {
      async listFilesWithMetadata() {
        return {
          files: [
            {
              path: "oc-template.toml",
              mode: "100644",
              size: 1,
              lastCommitSha: SHA,
              type: "blob" as const,
            },
          ],
          commits: {},
          ref: SHA,
          hasMore: false,
        };
      },
      async getFileStream() {
        return new Response("too large");
      },
    };
    await expect(
      materializeTemplateSnapshot(source, SHA, root),
    ).rejects.toThrow("exceeded its declared size");
  });
});

describe("linked repository deployment source", () => {
  it("supplies compiler metadata without requiring a repository template manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "linked-project-source-test-"));
    roots.push(root);

    await prepareLinkedProjectSource(root);

    await expect(readFile(join(root, "oc-template.toml"), "utf8")).resolves.toContain(
      'name = "Linked repository deployment"',
    );
  });

  it("ignores repository template metadata for an existing linked project", async () => {
    const root = await mkdtemp(join(tmpdir(), "linked-project-source-test-"));
    roots.push(root);
    const manifest = join(root, "oc-template.toml");
    await writeFile(
      manifest,
      'schema = 1\n[template]\nname = "Reusable template"\n',
    );

    await prepareLinkedProjectSource(root);

    const source = await readFile(manifest, "utf8");
    expect(source).toContain('name = "Linked repository deployment"');
    expect(source).not.toContain("Reusable template");
  });

  it("replaces a manifest symlink without following it", async () => {
    const root = await mkdtemp(join(tmpdir(), "linked-project-source-test-"));
    roots.push(root);
    const outside = join(root, "outside.txt");
    await writeFile(outside, "do not overwrite");
    await symlink(outside, join(root, "oc-template.toml"));

    await prepareLinkedProjectSource(root);

    await expect(readFile(outside, "utf8")).resolves.toBe("do not overwrite");
    expect((await lstat(join(root, "oc-template.toml"))).isFile()).toBe(true);
  });
});
