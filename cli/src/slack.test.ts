import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { runCommand } from "./commands.js";
import {
  addSlackChannel,
  initializeAgentProject,
} from "./project.js";
import {
  ensureSlackHooks,
  slackManifest,
  writeRemoteSlackState,
} from "./slack.js";

test("Slack channel state renders local and remote manifests", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-slack-"));
  const root = resolve(parent, "research-agent");
  try {
    const { agentRoot } = await initializeAgentProject(root);
    await addSlackChannel(agentRoot);
    await ensureSlackHooks(agentRoot);

    const local = await slackManifest(agentRoot, "local");
    assert.equal(
      (local.settings as Record<string, unknown>).socket_mode_enabled,
      true,
    );
    assert.equal(
      (await stat(resolve(agentRoot, ".opencomputer", "slack-hook.mjs"))).isFile(),
      true,
    );
    assert.match(
      await readFile(resolve(agentRoot, ".slack", "hooks.json"), "utf8"),
      /@opencomputer|opencomputer/,
    );

    await writeRemoteSlackState(agentRoot, {
      version: 1,
      connectionId: "channel-1",
      agentId: "research-agent@production",
      webhookUrl: "https://example.com/slack/events",
      apiUrl: "https://example.com",
    });
    const remote = await slackManifest(agentRoot, "remote");
    const settings = remote.settings as Record<string, unknown>;
    const subscriptions = settings.event_subscriptions as Record<
      string,
      unknown
    >;
    assert.equal(settings.socket_mode_enabled, false);
    assert.equal(subscriptions.request_url, "https://example.com/slack/events");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("Slack hooks accept source metadata from the Slack CLI", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-slack-hook-"));
  const root = resolve(parent, "research-agent");
  const previousDirectory = process.cwd();
  try {
    const { agentRoot } = await initializeAgentProject(root);
    await addSlackChannel(agentRoot);
    process.chdir(agentRoot);
    await assert.doesNotReject(
      runCommand("slack-hook", ["manifest", `--source=${agentRoot}`], {
        json: false,
      }),
    );
  } finally {
    process.chdir(previousDirectory);
    await rm(parent, { recursive: true, force: true });
  }
});
