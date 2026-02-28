/**
 * OpenSandbox Template System Demo
 *
 * Demonstrates creating a template from a running sandbox:
 *   1. Create a sandbox from the default "base" template
 *   2. Customize it (install packages, write scripts, add config)
 *   3. Save the running sandbox as a new template
 *   4. Launch a new sandbox from the saved template
 *   5. Verify all customizations persisted
 *
 * Usage:
 *   OPENCOMPUTER_API_URL=https://... OPENCOMPUTER_API_KEY=osb_... npx tsx demos/demo-templates.ts
 */

import { Sandbox } from "../sdks/typescript/src/index";
import { randomBytes } from "crypto";

const green = (s: string) => console.log(`\x1b[32m✓ ${s}\x1b[0m`);
const red   = (s: string) => console.log(`\x1b[31m✗ ${s}\x1b[0m`);
const bold  = (s: string) => console.log(`\x1b[1m${s}\x1b[0m`);
const dim   = (s: string) => console.log(`\x1b[2m  ${s}\x1b[0m`);
const step  = (s: string) => bold(`\n━━━ ${s} ━━━\n`);

async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const apiUrl = (process.env.OPENCOMPUTER_API_URL ?? "https://app.opencomputer.dev").replace(/\/+$/, "");
  const apiKey = process.env.OPENCOMPUTER_API_KEY ?? "";
  return fetch(`${apiUrl}/api${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "X-API-Key": apiKey } : {}),
      ...opts.headers,
    },
  });
}

async function main() {
  bold("\n╔══════════════════════════════════════════════════╗");
  bold("║       Template System Demo                       ║");
  bold("╚══════════════════════════════════════════════════╝\n");

  const suffix = randomBytes(4).toString("hex");
  const templateName = `demo-custom-env-${suffix}`;

  let sandbox1: Sandbox | null = null;
  let sandbox2: Sandbox | null = null;
  let templateId: string | null = null;

  try {
    // ── 1. Create a sandbox from base template ──────────────────
    step("1. Create a sandbox from the base template");

    sandbox1 = await Sandbox.create({ template: "base", timeout: 300 });
    green(`Sandbox created: ${sandbox1.sandboxId}`);

    // ── 2. Customize it ─────────────────────────────────────────
    step("2. Customize the sandbox");

    dim("Installing requests Python package...");
    const pipResult = await sandbox1.commands.run("pip install requests 2>&1 | tail -1", { timeout: 60 });
    dim(pipResult.stdout.trim());
    green("pip install requests complete");

    dim("Writing a Python script...");
    await sandbox1.files.write("/workspace/app.py", [
      '"""Custom application baked into the template."""',
      "import requests",
      "",
      "def fetch_status(url: str) -> int:",
      '    """Fetch a URL and return the HTTP status code."""',
      "    return requests.get(url, timeout=10).status_code",
      "",
      'if __name__ == "__main__":',
      '    print(f"httpbin.org status: {fetch_status(\'https://httpbin.org/status/200\')}")',
    ].join("\n"));
    green("Script written to /workspace/app.py");

    dim("Writing config file...");
    await sandbox1.files.write("/workspace/.env.example", [
      "# Configuration for the custom environment",
      "DATABASE_URL=postgres://localhost:5432/myapp",
      "REDIS_URL=redis://localhost:6379",
      `CREATED_AT=${new Date().toISOString()}`,
    ].join("\n"));
    green("Config written to /workspace/.env.example");

    dim("Creating project structure...");
    await sandbox1.commands.run("mkdir -p /workspace/src /workspace/tests /workspace/data");
    await sandbox1.files.write("/workspace/src/__init__.py", "# Custom src package\n");
    await sandbox1.files.write("/workspace/tests/__init__.py", "# Custom tests package\n");
    green("Project directories created");

    // ── 3. Save as template ─────────────────────────────────────
    step("3. Save the running sandbox as a template");

    dim(`Template name: ${templateName}`);
    const tmpl = await sandbox1.saveAsTemplate({ name: templateName });
    templateId = tmpl.id;
    green(`Template saved! (id=${templateId})`);
    dim(`This snapshots the rootfs + workspace and uploads to S3`);

    // Wait for template to be ready (S3 upload is async)
    dim("Waiting for template upload to complete...");
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const resp = await apiFetch(`/templates/${templateName}`);
      if (resp.ok) {
        const data = await resp.json();
        if (data.status === "ready") {
          ready = true;
          break;
        }
        dim(`Status: ${data.status} (waiting...)`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (ready) {
      green("Template is ready!");
    } else {
      red("Template did not become ready in time");
      return;
    }

    // ── 4. Launch from the saved template ───────────────────────
    step("4. Launch a new sandbox from the saved template");

    sandbox2 = await Sandbox.create({ template: templateName, timeout: 120 });
    green(`New sandbox created: ${sandbox2.sandboxId}`);
    dim("This sandbox booted from the snapshotted template");

    // ── 5. Verify customizations persisted ──────────────────────
    step("5. Verify all customizations persisted");

    dim("Checking requests package...");
    const importCheck = await sandbox2.commands.run("python3 -c 'import requests; print(requests.__version__)'");
    if (importCheck.exitCode === 0) {
      green(`requests ${importCheck.stdout.trim()} is installed`);
    } else {
      red("requests package not found");
    }

    dim("Checking app.py...");
    const appContent = await sandbox2.files.read("/workspace/app.py");
    if (appContent.includes("fetch_status")) {
      green("app.py exists with custom code");
    } else {
      red("app.py missing or empty");
    }

    dim("Checking .env.example...");
    const envContent = await sandbox2.files.read("/workspace/.env.example");
    if (envContent.includes("DATABASE_URL")) {
      green(".env.example exists with config");
    } else {
      red(".env.example missing");
    }

    dim("Checking project structure...");
    const lsResult = await sandbox2.commands.run("ls /workspace/src/__init__.py /workspace/tests/__init__.py 2>&1");
    if (lsResult.exitCode === 0) {
      green("Project directories and files persisted");
    } else {
      red("Project structure missing");
    }

    dim("Running the custom script...");
    const runResult = await sandbox2.commands.run("python3 /workspace/app.py", { timeout: 30 });
    if (runResult.exitCode === 0) {
      dim(runResult.stdout.trim());
      green("Custom script runs successfully in the new sandbox!");
    } else {
      red(`Script failed: ${runResult.stderr}`);
    }

  } catch (err: any) {
    red(`Error: ${err.message}`);
    console.error(err);
  } finally {
    step("Cleanup");

    if (sandbox2) {
      await sandbox2.kill();
      green("Sandbox 2 killed");
    }
    if (sandbox1) {
      await sandbox1.kill();
      green("Sandbox 1 killed");
    }
    if (templateName) {
      await apiFetch(`/templates/${templateName}`, { method: "DELETE" }).catch(() => {});
      green(`Template "${templateName}" deleted`);
    }
  }

  bold("\n╔══════════════════════════════════════════════════╗");
  bold("║  \x1b[32mTemplate System Demo Complete!\x1b[0m\x1b[1m                 ║");
  bold("╚══════════════════════════════════════════════════╝\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
