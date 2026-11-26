import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GitHubCredentialHolder,
  gitHubCredentialCovers,
  type GitHubCredential,
} from "../src/microvm/github-credential.js";

const run = promisify(execFile);
const T0 = Date.parse("2026-09-15T12:00:00Z");

function expiring(secondsFromT0: number): string {
  return new Date(T0 + secondsFromT0 * 1_000).toISOString();
}

async function askpass(holder: GitHubCredentialHolder, prompt: string): Promise<string> {
  const { stdout } = await run("sh", [holder.askPassFile, prompt]);
  return stdout;
}

describe("gitHubCredentialCovers", () => {
  it("is true only when the token outlives the command's allowed duration plus the margin", () => {
    const credential = { token: "t", expiresAt: expiring(3_600) };
    expect(gitHubCredentialCovers(credential, 120, T0)).toBe(true);
    expect(gitHubCredentialCovers(credential, 120, T0 + 3_400 * 1_000)).toBe(true);
    expect(gitHubCredentialCovers(credential, 120, T0 + 3_420 * 1_000)).toBe(false);
    expect(gitHubCredentialCovers(credential, 1_800, T0 + 1_700 * 1_000)).toBe(true);
    expect(gitHubCredentialCovers(credential, 1_800, T0 + 1_750 * 1_000)).toBe(false);
  });

  it("treats an unreadable expiry as expired", () => {
    expect(gitHubCredentialCovers({ token: "t", expiresAt: "soon" }, 1, T0)).toBe(false);
  });
});

describe("the computer's GitHub credential", () => {
  let directory: string;
  let now: number;
  let minted: GitHubCredential[];
  let refresh: ReturnType<typeof vi.fn<() => Promise<GitHubCredential | null>>>;
  let log: string[];
  let holder: GitHubCredentialHolder;

  beforeEach(async () => {
    directory = await mkdtemp(resolve(tmpdir(), "oc-github-credential-"));
    now = T0;
    minted = [];
    refresh = vi.fn(async () => {
      const credential = {
        token: `token-${String(minted.length + 2)}`,
        expiresAt: new Date(now + 3_600 * 1_000).toISOString(),
      };
      minted.push(credential);
      return credential;
    });
    log = [];
    holder = new GitHubCredentialHolder({
      directory,
      refresh,
      now: () => now,
      log: (line) => log.push(line),
    });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("dispatches without credential variables on a computer with no GitHub connection", async () => {
    await expect(holder.install(null)).resolves.toEqual({});
    await expect(holder.environmentForCommand(120)).resolves.toEqual({});
    expect(refresh).not.toHaveBeenCalled();
    expect(holder.expiresAt).toBeNull();
  });

  it("installs the token file and the helper git reads it through", async () => {
    const variables = await holder.install({ token: "token-1", expiresAt: expiring(3_600) });
    expect(variables).toEqual({
      GH_TOKEN: "token-1",
      GITHUB_TOKEN: "token-1",
      GIT_ASKPASS: holder.askPassFile,
      GIT_TERMINAL_PROMPT: "0",
    });
    expect((await stat(holder.tokenFile)).mode & 0o777).toBe(0o600);
    await expect(readFile(holder.tokenFile, "utf8")).resolves.toBe("token-1\n");
    await expect(askpass(holder, "Username for 'https://github.com': ")).resolves.toBe(
      "x-access-token\n",
    );
    await expect(askpass(holder, "Password for 'https://x-access-token@github.com': ")).resolves.toBe(
      "token-1\n",
    );
    await expect(run("sh", [holder.askPassFile, "something else"])).rejects.toMatchObject({ code: 1 });
  });

  it("keeps a token that outlives the command and hands it to gh", async () => {
    await holder.install({ token: "token-1", expiresAt: expiring(3_600) });
    now = T0 + 1_000 * 1_000;
    await expect(holder.environmentForCommand(120)).resolves.toEqual({
      GH_TOKEN: "token-1",
      GITHUB_TOKEN: "token-1",
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes before dispatch on a reused computer whose token is near expiry, for git through the helper and gh through the environment", async () => {
    await holder.install({ token: "token-1", expiresAt: expiring(3_600) });
    // The computer has been reused for most of an hour; a 120-second command
    // plus the margin would run past the token.
    now = T0 + 3_500 * 1_000;
    await expect(holder.environmentForCommand(120)).resolves.toEqual({
      GH_TOKEN: "token-2",
      GITHUB_TOKEN: "token-2",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await expect(askpass(holder, "Password for 'https://x-access-token@github.com': ")).resolves.toBe(
      "token-2\n",
    );
    expect(holder.expiresAt).toBe(new Date(now + 3_600 * 1_000).toISOString());
    expect(log.join("\n")).toContain("token refreshed");

    // The next command within the fresh token's life dispatches without another mint.
    now += 60 * 1_000;
    await expect(holder.environmentForCommand(120)).resolves.toEqual({
      GH_TOKEN: "token-2",
      GITHUB_TOKEN: "token-2",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes at the first dispatch on a new computer whose minted token is already short-lived", async () => {
    await holder.install({ token: "short-lived", expiresAt: expiring(90) });
    await expect(holder.environmentForCommand(120)).resolves.toEqual({
      GH_TOKEN: "token-2",
      GITHUB_TOKEN: "token-2",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await expect(readFile(holder.tokenFile, "utf8")).resolves.toBe("token-2\n");
  });

  it("decides by the command's allowed duration, not a fixed window", async () => {
    await holder.install({ token: "token-1", expiresAt: expiring(600) });
    await expect(holder.environmentForCommand(120)).resolves.toMatchObject({ GH_TOKEN: "token-1" });
    expect(refresh).not.toHaveBeenCalled();
    await expect(holder.environmentForCommand(1_800)).resolves.toMatchObject({ GH_TOKEN: "token-2" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shares one refresh between commands dispatched at the same time", async () => {
    await holder.install({ token: "token-1", expiresAt: expiring(90) });
    const [first, second] = await Promise.all([
      holder.environmentForCommand(120),
      holder.environmentForCommand(120),
    ]);
    expect(first).toEqual(second);
    expect(first.GH_TOKEN).toBe("token-2");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the held token when the refresh fails and says so", async () => {
    refresh.mockRejectedValueOnce(new Error("edge unreachable"));
    await holder.install({ token: "token-1", expiresAt: expiring(90) });
    await expect(holder.environmentForCommand(120)).resolves.toEqual({
      GH_TOKEN: "token-1",
      GITHUB_TOKEN: "token-1",
    });
    await expect(readFile(holder.tokenFile, "utf8")).resolves.toBe("token-1\n");
    expect(log.join("\n")).toContain("refresh failed (edge unreachable)");

    // A later dispatch tries again rather than remembering the failure.
    await expect(holder.environmentForCommand(120)).resolves.toMatchObject({ GH_TOKEN: "token-2" });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps the held token until it expires when the session no longer has a GitHub connection", async () => {
    refresh.mockResolvedValueOnce(null);
    await holder.install({ token: "token-1", expiresAt: expiring(90) });
    await expect(holder.environmentForCommand(120)).resolves.toMatchObject({ GH_TOKEN: "token-1" });
    expect(log.join("\n")).toContain("no longer has a GitHub connection");
  });
});
