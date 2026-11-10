import { describe, expect, it } from "vitest";

import {
  expectationMismatch,
  exportableWorkspacePath,
  fileTypeOfMode,
  regularFileMode,
  scopedWorkspaceArtifactKey,
  workspaceArtifactPrefix,
  workspaceDownloadFilename,
  workspaceExportExpectation,
  workspaceExportFingerprint,
  workspacePrefix,
} from "../src/platform/workspace-export.js";

describe("exportableWorkspacePath", () => {
  it("normalises relative and /workspace-rooted paths to the same key", () => {
    expect(exportableWorkspacePath("evidence/capture.har")).toBe("evidence/capture.har");
    expect(exportableWorkspacePath("/workspace/evidence/capture.har")).toBe("evidence/capture.har");
    expect(exportableWorkspacePath("./evidence/capture.har")).toBe("evidence/capture.har");
    expect(exportableWorkspacePath("  shot.png  ")).toBe("  shot.png  ");
    expect(exportableWorkspacePath("report.txt ")).toBe("report.txt ");
  });

  it("rejects absolute, traversal, malformed and oversized paths", () => {
    for (const unsafe of [
      "/etc/passwd",
      "/workspace",
      "../secret",
      "a/../b",
      "a/./b",
      "a//b",
      "a/",
      "a\\b",
      "a/\u0000b",
      "a/\u001fb",
      "",
      42,
      null,
      undefined,
      `${"x".repeat(1025)}`,
      `${"y".repeat(256)}/z`,
    ]) {
      expect(exportableWorkspacePath(unsafe), JSON.stringify(unsafe)).toBeNull();
    }
  });

  it("never exports the runtime's own seeded directories", () => {
    expect(exportableWorkspacePath(".opencode/config.json")).toBeNull();
    expect(exportableWorkspacePath("app/.opencomputer/state")).toBeNull();
    expect(exportableWorkspacePath(".git/HEAD")).toBeNull();
    expect(exportableWorkspacePath("app/node_modules/x/index.js")).toBeNull();
    expect(exportableWorkspacePath("app/.gitignore")).toBe("app/.gitignore");
  });
});

describe("regularFileMode", () => {
  it("accepts regular files and objects written without POSIX metadata", () => {
    expect(regularFileMode(undefined)).toBe(true);
    expect(regularFileMode("")).toBe(true);
    expect(regularFileMode("644")).toBe(true);
    expect(regularFileMode("0644")).toBe(true);
    expect(regularFileMode("100644")).toBe(true);
    expect(regularFileMode("100755")).toBe(true);
  });

  it("rejects symlinks, directories, devices and garbage", () => {
    expect(regularFileMode("120777")).toBe(false);
    expect(regularFileMode("40755")).toBe(false);
    expect(regularFileMode("020644")).toBe(false);
    expect(regularFileMode("10644")).toBe(false);
    expect(regularFileMode("rwxr-xr-x")).toBe(false);
    expect(regularFileMode("8")).toBe(false);
  });

  it("tells a symlink apart from other non-regular files so the refusal can say so", () => {
    expect(fileTypeOfMode("120777")).toBe("symlink");
    expect(fileTypeOfMode("40755")).toBe("other");
    expect(fileTypeOfMode("10644")).toBe("other");
    expect(fileTypeOfMode("100644")).toBe("regular");
  });
});

describe("export expectations", () => {
  it("parses and normalises what the caller expects, refusing malformed fields", () => {
    expect(workspaceExportExpectation(undefined)).toBeNull();
    expect(workspaceExportExpectation({})).toBeNull();
    expect(
      workspaceExportExpectation({ bytes: 12, sha256: "A".repeat(64), mediaType: "Text/Plain" }),
    ).toEqual({ bytes: 12, sha256: "a".repeat(64), mediaType: "text/plain" });
    for (const bad of ["x", [], { bytes: -1 }, { bytes: 1.5 }, { sha256: "abc" }, { mediaType: "text" }]) {
      expect(workspaceExportExpectation(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("fingerprints the canonical request independent of field order", async () => {
    const a = await workspaceExportFingerprint({ path: "a.txt", expected: { bytes: 1, sha256: "b".repeat(64) } });
    const b = await workspaceExportFingerprint({ path: "a.txt", expected: { sha256: "b".repeat(64), bytes: 1 } });
    expect(a).toBe(b);
    expect(await workspaceExportFingerprint({ path: "a.txt", expected: null })).not.toBe(a);
    expect(await workspaceExportFingerprint({ path: "b.txt", expected: { bytes: 1, sha256: "b".repeat(64) } })).not.toBe(a);
  });

  it("names the first field the retained snapshot disagrees with", () => {
    const observed = { size: 3, sha256: "c".repeat(64), mediaType: "text/plain; charset=utf-8" };
    expect(expectationMismatch(null, observed)).toBeNull();
    expect(expectationMismatch({ bytes: 3, sha256: "c".repeat(64), mediaType: "text/plain" }, observed)).toBeNull();
    expect(expectationMismatch({ bytes: 4 }, observed)).toBe("artifact_size_mismatch");
    expect(expectationMismatch({ sha256: "d".repeat(64) }, observed)).toBe("artifact_digest_mismatch");
    expect(expectationMismatch({ mediaType: "image/png" }, observed)).toBe("artifact_media_type_mismatch");
  });
});

describe("workspace prefixes", () => {
  it("scopes both the source and the retained copies to the account and session", () => {
    expect(workspacePrefix("acct/1", "sess")).toBe("accounts/acct_1/sessions/sess/");
    expect(workspaceArtifactPrefix("acct/1", "sess")).toBe(
      "accounts/acct_1/workspace-artifacts/sess/",
    );
    // Retained copies never appear in a workspace listing, even when the
    // workspace and artifact buckets are the same bucket.
    expect(workspaceArtifactPrefix("a", "s").startsWith(workspacePrefix("a", "s"))).toBe(false);
  });

  it("accepts only content-addressed artifact keys inside the exact session scope", () => {
    const prefix = workspaceArtifactPrefix("acct/1", "sess");
    const key = `${prefix}${"a".repeat(64)}/${"b".repeat(64)}`;
    expect(scopedWorkspaceArtifactKey("acct/1", "sess", key)).toBe(key);
    expect(scopedWorkspaceArtifactKey("acct/2", "sess", key)).toBeNull();
    expect(scopedWorkspaceArtifactKey("acct/1", "other", key)).toBeNull();
    expect(scopedWorkspaceArtifactKey("acct/1", "sess", `${prefix}pending/x`)).toBeNull();
    expect(scopedWorkspaceArtifactKey("acct/1", "sess", 42)).toBeNull();
  });

  it("allows Unicode attachment basenames but rejects path and header injection", () => {
    expect(workspaceDownloadFilename("report ☃.pdf")).toBe("report ☃.pdf");
    for (const unsafe of ["", "a/b", "a\\b", "a\nb", "a\u0000b", "x".repeat(256), null]) {
      expect(workspaceDownloadFilename(unsafe), JSON.stringify(unsafe)).toBeNull();
    }
  });
});
