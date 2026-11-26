import { describe, expect, it } from "vitest";

import {
  parsePublicGitHubRepository,
  templateMirrorRepoId,
  templateProjectRepoId,
} from "../src/templates/code-storage.js";

describe("template Code.Storage identities", () => {
  it("accepts only root public GitHub HTTPS URLs", () => {
    expect(
      parsePublicGitHubRepository("https://github.com/diggerhq/opencomputer"),
    ).toEqual({
      owner: "diggerhq",
      name: "opencomputer",
      fullName: "diggerhq/opencomputer",
      url: "https://github.com/diggerhq/opencomputer",
    });
    for (const value of [
      "http://github.com/diggerhq/opencomputer",
      "https://github.com/diggerhq/opencomputer/tree/main",
      "https://github.com/diggerhq/opencomputer.git",
      "https://github.com/diggerhq/opencomputer?ref=main",
    ]) {
      expect(() => parsePublicGitHubRepository(value)).toThrow();
    }
  });

  it("uses stable bounded private repository names", () => {
    expect(templateMirrorRepoId("DiggerHQ/OpenComputer")).toBe(
      templateMirrorRepoId("diggerhq/opencomputer"),
    );
    expect(templateMirrorRepoId("diggerhq/opencomputer")).toMatch(
      /^template-[0-9a-f]{24}$/,
    );
    expect(templateProjectRepoId("tplinst_ABC/123")).toBe(
      "project-tplinst-abc-123",
    );
  });
});
