/**
 * Multi-Template Production Test
 *
 * Verifies all 3 templates (base, python, node) create, run commands,
 * and have the expected runtimes available.
 *
 * Usage:
 *   npx tsx examples/test-multi-template.ts
 */

import { Sandbox } from "../src/index";

function green(msg: string) { console.log(`\x1b[32m✓ ${msg}\x1b[0m`); }
function red(msg: string) { console.log(`\x1b[31m✗ ${msg}\x1b[0m`); }
function bold(msg: string) { console.log(`\x1b[1m${msg}\x1b[0m`); }
function dim(msg: string) { console.log(`\x1b[2m  ${msg}\x1b[0m`); }

let passed = 0;
let failed = 0;

function check(desc: string, condition: boolean, detail?: string) {
  if (condition) {
    green(desc);
    passed++;
  } else {
    red(`${desc}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

interface TemplateTest {
  template: string;
  expectedBinary: string;
  versionCmd: string;
  versionPrefix: string;
  testCmd: string;
  testExpected: string;
}

const TEMPLATES: TemplateTest[] = [
  {
    template: "base",
    expectedBinary: "bash",
    versionCmd: "bash --version | head -1",
    versionPrefix: "GNU bash",
    testCmd: "echo 'hello from base'",
    testExpected: "hello from base",
  },
  {
    template: "python",
    expectedBinary: "python3",
    versionCmd: "python3 --version",
    versionPrefix: "Python 3",
    testCmd: "python3 -c \"print(2 + 2)\"",
    testExpected: "4",
  },
  {
    template: "node",
    expectedBinary: "node",
    versionCmd: "node --version",
    versionPrefix: "v",
    testCmd: "node -e \"console.log(JSON.stringify({ok:true}))\"",
    testExpected: '{"ok":true}',
  },
];

async function testTemplate(t: TemplateTest, index: number): Promise<{ passed: number; failed: number }> {
  let p = 0;
  let f = 0;

  const localCheck = (desc: string, condition: boolean, detail?: string) => {
    if (condition) { green(desc); p++; } else { red(`${desc}${detail ? ` (${detail})` : ""}`); f++; }
  };

  bold(`\n━━━ Template ${index + 1}/3: "${t.template}" ━━━\n`);
  let sandbox: Sandbox | null = null;

  try {
    // Create
    const start = Date.now();
    sandbox = await Sandbox.create({ template: t.template, timeout: 120 });
    const createMs = Date.now() - start;
    localCheck(`Created ${t.template} sandbox (${createMs}ms)`, true);
    dim(`ID: ${sandbox.sandboxId}`);
    dim(`Domain: ${sandbox.domain}`);

    // Verify domain assigned
    localCheck(`Domain assigned`, !!sandbox.domain);

    // Check expected binary exists
    const which = await sandbox.commands.run(`which ${t.expectedBinary}`);
    localCheck(`${t.expectedBinary} binary exists`, which.exitCode === 0, which.stderr.trim());

    // Get version
    const version = await sandbox.commands.run(t.versionCmd);
    localCheck(
      `Version starts with "${t.versionPrefix}"`,
      version.stdout.trim().startsWith(t.versionPrefix),
      version.stdout.trim(),
    );
    dim(`Version: ${version.stdout.trim()}`);

    // Run template-specific test command
    const test = await sandbox.commands.run(t.testCmd);
    localCheck(
      `Test command output correct`,
      test.stdout.trim() === t.testExpected,
      `expected "${t.testExpected}", got "${test.stdout.trim()}"`,
    );

    // Verify basic file ops work
    await sandbox.files.write("/tmp/template-test.txt", `from-${t.template}`);
    const content = await sandbox.files.read("/tmp/template-test.txt");
    localCheck(`File ops work`, content === `from-${t.template}`);

    // Verify uname (should always be Linux)
    const uname = await sandbox.commands.run("uname -s");
    localCheck(`Running on Linux`, uname.stdout.trim() === "Linux");

  } catch (err: any) {
    red(`  Error testing ${t.template}: ${err.message}`);
    f++;
  } finally {
    if (sandbox) {
      await sandbox.kill();
      dim(`Sandbox killed`);
    }
  }

  return { passed: p, failed: f };
}

async function main() {
  bold("\n╔══════════════════════════════════════════════════╗");
  bold("║       Multi-Template Production Test             ║");
  bold("╚══════════════════════════════════════════════════╝");

  for (let i = 0; i < TEMPLATES.length; i++) {
    const result = await testTemplate(TEMPLATES[i], i);
    passed += result.passed;
    failed += result.failed;
  }

  console.log();
  bold("========================================");
  bold(` Results: ${passed} passed, ${failed} failed`);
  bold("========================================\n");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
