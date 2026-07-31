import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadStoredConfig,
  normalizeAPIURL,
  saveStoredConfig,
} from "./config.js";

test("normalizes the public API URL and rejects insecure remotes", () => {
  assert.equal(
    normalizeAPIURL("https://app.opencomputer.dev/api/"),
    "https://app.opencomputer.dev",
  );
  assert.throws(() => normalizeAPIURL("http://example.com"));
  assert.equal(
    normalizeAPIURL("http://localhost:8787"),
    "http://localhost:8787",
  );
});

test("stores agent CLI credentials in a mode-0600 file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencomputer-cli-"));
  const path = join(directory, "nested", "config.json");
  process.env.OPENCOMPUTER_CONFIG = path;
  try {
    await saveStoredConfig({
      apiUrl: "https://app.opencomputer.dev",
      apiKey: "osb_test",
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await loadStoredConfig(), {
      apiUrl: "https://app.opencomputer.dev",
      apiKey: "osb_test",
    });
    assert.match(await readFile(path, "utf8"), /"apiKey": "osb_test"/);
  } finally {
    delete process.env.OPENCOMPUTER_CONFIG;
  }
});
