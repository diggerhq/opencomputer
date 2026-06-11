import { createHash } from "crypto";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

export interface ImageStep {
  type: "apt_install" | "pip_install" | "run" | "env" | "workdir" | "add_file" | "add_dir";
  args: Record<string, unknown>;
}

export interface ImageManifest {
  base: string;
  steps: ImageStep[];
  /** RAM (MB) for the build phase (apt/pip). Omit for the server default. Does
   * NOT pin the output — the server re-snapshots at the default 1 GB floor, and
   * you size the actual sandbox at create time via memoryMB. */
  builderMemoryMB?: number;
}

/**
 * Declarative image builder for OpenSandbox.
 *
 * Defines a reproducible sandbox environment via a fluent API.
 * Under the hood, the manifest is sent to the server which boots a base sandbox,
 * executes each step, checkpoints the result, and caches it by content hash.
 *
 * @example
 * ```typescript
 * const image = Image.base()
 *   .aptInstall(['curl', 'git'])
 *   .pipInstall(['requests', 'pandas'])
 *   .addFile('/workspace/config.json', '{"key": "value"}')
 *   .env({ PROJECT_ROOT: '/workspace' })
 *   .workdir('/workspace')
 *
 * // Heavy build that should still fork down to the default floor:
 * const big = Image.base().aptInstall(['build-essential']).builderMemory(8192)
 *
 * // On-demand: cached by content hash
 * const sandbox = await Sandbox.create({ image })
 *
 * // Pre-built snapshot
 * const snapshots = new Snapshots()
 * await snapshots.create({ name: 'data-science', image })
 * ```
 */
export class Image {
  private readonly manifest: ImageManifest;

  private constructor(manifest: ImageManifest) {
    this.manifest = manifest;
  }

  /**
   * Create a new image starting from the default OpenSandbox environment
   * (Ubuntu 22.04 with Python, Node.js, build tools, and common utilities).
   * Customize by chaining steps like `.aptInstall()`, `.pipInstall()`, `.runCommands()`, etc.
   */
  static base(): Image {
    return new Image({ base: "base", steps: [] });
  }

  /** Append a step, preserving base + memory settings. */
  private withStep(step: ImageStep): Image {
    return new Image({ ...this.manifest, steps: [...this.manifest.steps, step] });
  }

  /**
   * Install system packages via apt-get.
   */
  aptInstall(packages: string[]): Image {
    return this.withStep({ type: "apt_install", args: { packages } });
  }

  /**
   * Install Python packages via pip.
   */
  pipInstall(packages: string[]): Image {
    return this.withStep({ type: "pip_install", args: { packages } });
  }

  /**
   * Run one or more shell commands.
   */
  runCommands(...commands: string[]): Image {
    return this.withStep({ type: "run", args: { commands } });
  }

  /**
   * Set environment variables (written to /etc/environment).
   */
  env(vars: Record<string, string>): Image {
    return this.withStep({ type: "env", args: { vars } });
  }

  /**
   * Set the default working directory.
   */
  workdir(path: string): Image {
    return this.withStep({ type: "workdir", args: { path } });
  }

  /**
   * Add a file with inline content to the image.
   * @param remotePath - Absolute path inside the sandbox where the file will be written.
   * @param content - String content of the file.
   */
  addFile(remotePath: string, content: string): Image {
    const encoded = Buffer.from(content).toString("base64");
    return this.withStep({ type: "add_file", args: { path: remotePath, content: encoded, encoding: "base64" } });
  }

  /**
   * Add a local file into the image.
   * Reads the file from disk and embeds its content in the manifest.
   * @param localPath - Path to the file on the local machine.
   * @param remotePath - Absolute path inside the sandbox where the file will be written.
   */
  addLocalFile(localPath: string, remotePath: string): Image {
    const content = readFileSync(localPath);
    const encoded = content.toString("base64");
    return this.withStep({ type: "add_file", args: { path: remotePath, content: encoded, encoding: "base64" } });
  }

  /**
   * Add a local directory into the image.
   * Recursively reads all files and embeds them in the manifest.
   * @param localPath - Path to the directory on the local machine.
   * @param remotePath - Absolute path inside the sandbox where the directory will be created.
   */
  addLocalDir(localPath: string, remotePath: string): Image {
    const files: Array<{ relativePath: string; content: string }> = [];
    collectFiles(localPath, localPath, files);
    return this.withStep({ type: "add_dir", args: { path: remotePath, files } });
  }

  /**
   * Set the RAM (MB) for the build phase. Use this when a build OOMs at the
   * default 4 GB (e.g. heavy `apt`/`pip`/`npm`). Does not affect the resulting
   * image's memory — size the sandbox at create time via `memoryMB`.
   */
  builderMemory(mb: number): Image {
    return new Image({ ...this.manifest, builderMemoryMB: mb });
  }

  /**
   * Returns the manifest as a plain object (for JSON serialization).
   */
  toJSON(): ImageManifest {
    return this.manifest;
  }

  /**
   * Compute a deterministic content hash for caching. Memory knobs are resource
   * params, not image content, so they're excluded (matches the server).
   */
  cacheKey(): string {
    const canonical = JSON.stringify({ base: this.manifest.base, steps: this.manifest.steps });
    return createHash("sha256").update(canonical).digest("hex");
  }
}

function collectFiles(
  basePath: string,
  currentPath: string,
  out: Array<{ relativePath: string; content: string }>
): void {
  for (const entry of readdirSync(currentPath)) {
    const full = join(currentPath, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectFiles(basePath, full, out);
    } else if (stat.isFile()) {
      out.push({
        relativePath: relative(basePath, full),
        content: readFileSync(full).toString("base64"),
      });
    }
  }
}
