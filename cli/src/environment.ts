import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

const APPROVED_RUNTIME =
  /^registry\.opencomputer\.dev\/serverless-agent:(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_CONTEXT_BYTES = 20 * 1024 * 1024;

export interface AgentEnvironmentSource {
  body: Buffer;
  digest: string;
  size: number;
  contentType: "application/vnd.opencomputer.agent-environment+json";
  baseImage: string;
  architecture: "linux/arm64";
}

interface DockerfileStage {
  approvedBase?: string;
}

function dockerfileLines(source: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (const physical of source.replaceAll("\r\n", "\n").split("\n")) {
    const continued = /\\\s*$/.test(physical);
    current += `${current ? " " : ""}${physical.replace(/\\\s*$/, "").trim()}`;
    if (!continued) {
      if (current) lines.push(current);
      current = "";
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function validateAgentDockerfile(source: string): { baseImage: string } {
  const stages = new Map<string, DockerfileStage>();
  let finalStage: DockerfileStage | undefined;
  for (const line of dockerfileLines(source)) {
    if (/^#\s*syntax\s*=/i.test(line)) {
      throw new Error("Agent Dockerfiles cannot select a custom Dockerfile frontend");
    }
    if (line.startsWith("#")) continue;
    const [instruction = "", ...rest] = line.split(/\s+/);
    if (instruction.toUpperCase() !== "FROM") continue;
    const tokens = rest.filter((token) => !token.startsWith("--platform="));
    const image = tokens[0];
    if (!image) throw new Error("Every FROM instruction requires an image");
    if (image.includes("$") || image.includes("${")) {
      throw new Error("Agent Dockerfile FROM images cannot use build arguments");
    }
    const inherited = stages.get(image.toLowerCase());
    const match = image.match(APPROVED_RUNTIME);
    finalStage = {
      approvedBase: match ? image : inherited?.approvedBase,
    };
    if (tokens[1]?.toUpperCase() === "AS") {
      const alias = tokens[2];
      if (!alias || !/^[a-zA-Z0-9_.-]+$/.test(alias)) {
        throw new Error("Dockerfile stage aliases must be static names");
      }
      stages.set(alias.toLowerCase(), finalStage);
    }
  }
  if (!finalStage) throw new Error("Agent Dockerfile must contain a FROM instruction");
  if (!finalStage.approvedBase) {
    throw new Error(
      "The final Dockerfile stage must inherit from registry.opencomputer.dev/serverless-agent:<version>",
    );
  }
  return { baseImage: finalStage.approvedBase };
}

async function collectSandboxFiles(
  agentRoot: string,
  directory: string,
): Promise<Array<{ path: string; content: string }>> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);
    const normalized = relative(agentRoot, path).split("\\").join("/");
    if (
      entry.name === ".git" ||
      entry.name === ".opencomputer" ||
      entry.name === "node_modules" ||
      entry.name === ".env" ||
      entry.name.startsWith(".env.")
    ) {
      throw new Error(`Agent environment context cannot include ${normalized}`);
    }
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Agent environment context cannot include symlink ${normalized}`);
    }
    if (metadata.isDirectory()) {
      files.push(...(await collectSandboxFiles(agentRoot, path)));
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`Agent environment context only supports regular files: ${normalized}`);
    }
    if (metadata.size > MAX_FILE_BYTES) {
      throw new Error(`Agent environment file exceeds 5 MiB: ${normalized}`);
    }
    files.push({ path: normalized, content: (await readFile(path)).toString("base64") });
  }
  return files;
}

export async function buildAgentEnvironment(
  agentRoot: string,
): Promise<AgentEnvironmentSource | undefined> {
  const dockerfilePath = resolve(agentRoot, "Dockerfile");
  let dockerfile: Buffer;
  try {
    const metadata = await lstat(dockerfilePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Agent Dockerfile must be a regular file");
    }
    dockerfile = await readFile(dockerfilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const { baseImage } = validateAgentDockerfile(dockerfile.toString("utf8"));
  const files = [
    { path: "Dockerfile", content: dockerfile.toString("base64") },
    ...(await collectSandboxFiles(agentRoot, resolve(agentRoot, "sandbox"))),
  ];
  const decodedSize = files.reduce(
    (total, file) => total + Buffer.byteLength(file.content, "base64"),
    0,
  );
  if (decodedSize > MAX_CONTEXT_BYTES) {
    throw new Error("Agent environment context exceeds 20 MiB");
  }
  const body = Buffer.from(
    JSON.stringify({
      version: 1,
      architecture: "linux/arm64",
      baseImage,
      files,
    }),
  );
  return {
    body,
    digest: createHash("sha256").update(body).digest("hex"),
    size: body.byteLength,
    contentType: "application/vnd.opencomputer.agent-environment+json",
    baseImage,
    architecture: "linux/arm64",
  };
}
