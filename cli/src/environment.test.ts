import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildAgentEnvironment,
  validateAgentDockerfile,
} from "./environment.js";

const runtime = "registry.opencomputer.dev/serverless-agent:0.6.5";

test("accepts a versioned OpenComputer runtime as the final stage", () => {
  assert.deepEqual(validateAgentDockerfile(`FROM ${runtime}\nRUN npm i`), {
    baseImage: runtime,
  });
});

test("accepts a final stage descended from an approved named stage", () => {
  assert.deepEqual(
    validateAgentDockerfile(`
FROM node:22 AS build
RUN echo compiling
FROM ${runtime} AS platform
COPY --from=build /tmp/result /tmp/result
FROM platform AS final
RUN echo ready
`),
    { baseImage: runtime },
  );
});

test("rejects an arbitrary or mutable final runtime", () => {
  assert.throws(
    () => validateAgentDockerfile("FROM ubuntu:24.04"),
    /final Dockerfile stage must inherit/,
  );
  assert.throws(
    () =>
      validateAgentDockerfile(
        "FROM registry.opencomputer.dev/serverless-agent:latest",
      ),
    /final Dockerfile stage must inherit/,
  );
});

test("rejects build arguments in FROM and custom frontends", () => {
  assert.throws(
    () => validateAgentDockerfile("ARG BASE\nFROM ${BASE}"),
    /cannot use build arguments/,
  );
  assert.throws(
    () => validateAgentDockerfile(`# syntax=example/custom:1\nFROM ${runtime}`),
    /custom Dockerfile frontend/,
  );
});

test("packages a deterministic narrow environment context", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-environment-"));
  try {
    await mkdir(resolve(root, "sandbox"));
    await writeFile(resolve(root, "Dockerfile"), `FROM ${runtime}\n`);
    await writeFile(resolve(root, "sandbox", "requirements.txt"), "ruff==1.0\n");
    await writeFile(resolve(root, "ignored.txt"), "not in context\n");
    const first = await buildAgentEnvironment(root);
    const second = await buildAgentEnvironment(root);
    assert.ok(first);
    assert.equal(first.digest, second?.digest);
    assert.equal(first.baseImage, runtime);
    const body = JSON.parse(first.body.toString("utf8")) as {
      files: Array<{ path: string }>;
    };
    assert.deepEqual(
      body.files.map((file) => file.path),
      ["Dockerfile", "sandbox/requirements.txt"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symlinks and secret-looking context files", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-environment-"));
  try {
    await mkdir(resolve(root, "sandbox"));
    await writeFile(resolve(root, "Dockerfile"), `FROM ${runtime}\n`);
    await writeFile(resolve(root, "outside"), "secret");
    await symlink(resolve(root, "outside"), resolve(root, "sandbox", "link"));
    await assert.rejects(buildAgentEnvironment(root), /cannot include symlink/);
    await rm(resolve(root, "sandbox", "link"));
    await writeFile(resolve(root, "sandbox", ".env.local"), "TOKEN=nope\n");
    await assert.rejects(buildAgentEnvironment(root), /cannot include sandbox\/\.env\.local/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
