import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeTemplateRepositoryUrl,
  parseTemplateManifest,
  templateDeployUrl,
} from "./template.js";

const example = `schema = 1

[template]
name = "GitHub Actions Triage"
description = "Investigate failed workflows."
documentation = "https://github.com/diggerhq/example"
default_project_name = "github-actions-triage"

[template.first_run]
agent = "triage"
prompt = "Inspect the latest failed workflow."

[template.secrets.GITHUB_TOKEN]
description = "Fine-grained token."

[template.runtime_variables.GITHUB_REPOSITORY]
description = "Repository in owner/name form."
required = true
example = "diggerhq/opencomputer"

[template.connections.github]
description = "Connect GitHub."
`;

test("parses the v1 template contract", () => {
  assert.deepEqual(parseTemplateManifest(example), {
    schema: 1,
    template: {
      name: "GitHub Actions Triage",
      description: "Investigate failed workflows.",
      documentation: "https://github.com/diggerhq/example",
      defaultProjectName: "github-actions-triage",
      firstRun: {
        agent: "triage",
        prompt: "Inspect the latest failed workflow.",
      },
      secrets: { GITHUB_TOKEN: { description: "Fine-grained token." } },
      runtimeVariables: {
        GITHUB_REPOSITORY: {
          description: "Repository in owner/name form.",
          required: true,
          example: "diggerhq/opencomputer",
        },
      },
      connections: { github: { description: "Connect GitHub." } },
    },
  });
});

test("rejects unknown fields and incomplete first-run metadata", () => {
  assert.throws(
    () => parseTemplateManifest(`${example}\n[template.unsafe]\n`),
    /unknown table template\.unsafe/,
  );
  assert.throws(
    () =>
      parseTemplateManifest(
        example.replace(
          'description = "Investigate failed workflows."',
          'description = "Investigate failed workflows."\nunsafe = "yes"',
        ),
      ),
    /unknown field template\.unsafe/,
  );
  assert.throws(
    () =>
      parseTemplateManifest(
        `schema = 1\n[template]\nname = "A"\ndescription = "B"\n[template.first_run]\nagent = "a"\n`,
      ),
    /must be provided together/,
  );
});

test("requires HTTPS documentation URLs", () => {
  assert.throws(
    () =>
      parseTemplateManifest(
        example.replace("https://github.com", "http://github.com"),
      ),
    /must be an HTTPS URL/,
  );
});

test("normalizes only root GitHub repository URLs", () => {
  assert.equal(
    normalizeTemplateRepositoryUrl("https://github.com/diggerhq/opencomputer"),
    "https://github.com/diggerhq/opencomputer",
  );
  for (const invalid of [
    "https://gitlab.com/diggerhq/opencomputer",
    "https://github.com/diggerhq/opencomputer/tree/main",
    "https://github.com/diggerhq/opencomputer.git",
    "https://github.com/diggerhq/opencomputer?ref=main",
  ]) {
    assert.throws(
      () => normalizeTemplateRepositoryUrl(invalid),
      /Repository URL/,
    );
  }
});

test("builds the canonical dashboard handoff without a ref", () => {
  assert.equal(
    templateDeployUrl("https://github.com/diggerhq/opencomputer"),
    "https://app.opencomputer.dev/new?repository-url=https%3A%2F%2Fgithub.com%2Fdiggerhq%2Fopencomputer",
  );
});
