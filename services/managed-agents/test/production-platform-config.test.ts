import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

type WranglerConfig = {
  vars?: Record<string, string>;
  durable_objects?: {
    bindings?: Array<{
      name?: string;
      class_name?: string;
      script_name?: string;
    }>;
  };
  migrations?: Array<{ tag?: string; new_sqlite_classes?: string[] }>;
  services?: Array<{ binding?: string; service?: string }>;
  tail_consumers?: Array<{ service?: string }>;
};

function readConfig(name: string): WranglerConfig {
  const path = fileURLToPath(new URL(`../${name}`, import.meta.url));
  // JSONC: drop whole-line comments and trailing commas.
  const text = readFileSync(path, "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(text) as WranglerConfig;
}

describe("production platform configuration", () => {
  it("sends the workerd runtime's sandbox and artifact calls to the one platform Worker", () => {
    // A second platform Worker for sandboxes drifted from this one three
    // times (supervisor ports, the Modal gate, the runtime image); keep one.
    const workerd = readConfig("wrangler.workerd.jsonc");
    const services = Object.fromEntries(
      (workerd.services ?? []).map((entry) => [entry.binding, entry.service]),
    );
    expect(services.SANDBOX).toBe("managed-agents-platform");
    expect(services.ARTIFACTS).toBe("managed-agents-platform");
  });

  it.each(["wrangler.platform.jsonc"])("keeps the unused RunMicrovm admission class bound in %s", (name) => {
    // Removing the class needs a deleted_classes migration.
    const config = readConfig(name);
    expect(config.durable_objects?.bindings).toContainEqual({
      name: "RUN_MICROVM_ADMISSION",
      class_name: "RunMicrovmAdmission",
    });
    expect(config.migrations).toContainEqual({
      tag: "v1-run-microvm-admission",
      new_sqlite_classes: ["RunMicrovmAdmission"],
    });
  });

  it("ships the logs of every deployed Worker to Axiom", () => {
    // Without a tail consumer a Worker's logs live only in Cloudflare, out of
    // reach of the Axiom queries that join edge, platform and sandbox logs.
    const configs = [
      "wrangler.platform.jsonc",
      "wrangler.previews.jsonc",
      "wrangler.production.jsonc",
      "wrangler.wire.jsonc",
      "wrangler.workerd.jsonc",
    ];
    for (const name of configs) {
      expect(readConfig(name).tail_consumers, name).toContainEqual({
        service: "opencomputer-log-tail-prod",
      });
    }
  });
});
