import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { findAgentRoot, readManifest } from "./project.js";

export interface LocalSlackState {
  version: 1;
  appId: string;
  teamId: string;
  teamName?: string;
}

export interface RemoteSlackState {
  version: 1;
  connectionId: string;
  agentId: string;
  webhookUrl: string;
  apiUrl: string;
}

interface SlackAppEntry {
  app_id?: string;
  team_domain?: string;
  team_id?: string;
}

interface SlackAppsFile {
  apps?: Record<string, SlackAppEntry>;
  default?: string;
  [key: string]: unknown;
}

const OPENCOMPUTER_SLACK_HOOKS = {
  "get-manifest": "node .opencomputer/slack-hook.mjs manifest",
  start: "node .opencomputer/slack-hook.mjs start",
  deploy: "node .opencomputer/slack-hook.mjs deploy",
} as const;

const OPENCOMPUTER_SLACK_HOOK_BRIDGE = `#!/usr/bin/env node
import { spawn } from "node:child_process";

const [action, ...extraArgs] = process.argv.slice(2);
if (!["manifest", "start", "deploy"].includes(action)) {
  process.stderr.write("Unsupported OpenComputer Slack hook\\n");
  process.exit(1);
}

const cliEntry = process.env.OPENCOMPUTER_SLACK_CLI_ENTRY;
const command = cliEntry
  ? process.env.OPENCOMPUTER_SLACK_NODE_EXECUTABLE || process.execPath
  : process.platform === "win32"
    ? "npx.cmd"
    : "npx";
const args = cliEntry
  ? [cliEntry, "slack-hook", action, ...extraArgs]
  : [
      "-y",
      "@opencomputer/cli@latest",
      "slack-hook",
      action,
      ...extraArgs,
    ];
const child = spawn(command, args, { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  process.stderr.write(\`opencomputer: \${error.message}\\n\`);
  process.exit(1);
});
child.once("exit", (code) => process.exit(code ?? 1));
`;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function localSlackStatePath(root: string): string {
  return resolve(root, ".opencomputer", "channels", "slack.local.json");
}

export function remoteSlackStatePath(root: string): string {
  return resolve(root, ".opencomputer", "channels", "slack.remote.json");
}

export async function readLocalSlackState(
  root: string,
): Promise<LocalSlackState | undefined> {
  try {
    return JSON.parse(
      await readFile(localSlackStatePath(root), "utf8"),
    ) as LocalSlackState;
  } catch {
    return undefined;
  }
}

export async function readRemoteSlackState(
  root: string,
): Promise<RemoteSlackState | undefined> {
  try {
    return JSON.parse(
      await readFile(remoteSlackStatePath(root), "utf8"),
    ) as RemoteSlackState;
  } catch {
    return undefined;
  }
}

export async function writeRemoteSlackState(
  root: string,
  state: RemoteSlackState,
): Promise<void> {
  const path = remoteSlackStatePath(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function clearSlackState(
  root: string,
  mode: "local" | "remote",
): Promise<void> {
  await rm(
    mode === "local"
      ? localSlackStatePath(root)
      : remoteSlackStatePath(root),
    { force: true },
  );
}

export async function ensureSlackHooks(root: string): Promise<void> {
  const path = resolve(root, ".slack", "hooks.json");
  await mkdir(dirname(path), { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // A new Slack project does not have hooks yet.
  }
  const hooks =
    existing.hooks &&
    typeof existing.hooks === "object" &&
    !Array.isArray(existing.hooks)
      ? (existing.hooks as Record<string, unknown>)
      : {};
  const startHook = hooks.start;
  const managed =
    startHook === undefined ||
    (typeof startHook === "string" &&
      (startHook.includes("@opencomputer/cli") ||
        startHook.includes(".opencomputer/slack-hook.mjs") ||
        startHook.includes("@opencomputer/blue") ||
        startHook.includes(".blue/slack-hook.mjs")));
  if (!managed) return;
  const config =
    existing.config &&
    typeof existing.config === "object" &&
    !Array.isArray(existing.config)
      ? (existing.config as Record<string, unknown>)
      : {};
  await writeFile(
    path,
    `${JSON.stringify(
      {
        ...existing,
        hooks: { ...hooks, ...OPENCOMPUTER_SLACK_HOOKS },
        config: { ...config, "sdk-managed-connection-enabled": true },
      },
      null,
      2,
    )}\n`,
  );
  const bridge = resolve(root, ".opencomputer", "slack-hook.mjs");
  await mkdir(dirname(bridge), { recursive: true });
  await writeFile(bridge, OPENCOMPUTER_SLACK_HOOK_BRIDGE, { mode: 0o755 });
}

export async function requireSlackAgentRoot(): Promise<string> {
  const root = await findAgentRoot();
  if (!root || !(await exists(resolve(root, "channels", "slack.ts")))) {
    throw new Error(
      "Run `opencomputer channels add slack` inside an agent repository first.",
    );
  }
  await ensureSlackHooks(root);
  return root;
}

export async function slackManifest(
  root: string,
  mode: "local" | "remote",
): Promise<Record<string, unknown>> {
  const manifest = await readManifest(root);
  const remote =
    mode === "remote" ? await readRemoteSlackState(root) : undefined;
  if (mode === "remote" && !remote?.webhookUrl) {
    throw new Error(
      "Run `opencomputer channels connect slack --remote` first.",
    );
  }
  const subscriptions: Record<string, unknown> = {
    bot_events: [
      "app_mention",
      "app_context_changed",
      "app_home_opened",
      "message.im",
    ],
  };
  if (remote) subscriptions.request_url = remote.webhookUrl;
  return {
    _metadata: { major_version: 1, minor_version: 1 },
    display_information: {
      name: manifest.name || basename(root),
      description: `Run the ${manifest.name} OpenComputer agent from Slack.`,
      background_color: "#0B1220",
    },
    features: {
      agent_view: {
        agent_description: `Work with the ${manifest.name} agent.`,
        suggested_prompts: [
          {
            title: "Get started",
            message: "Tell me what you can help with.",
          },
        ],
      },
      bot_user: {
        display_name: manifest.name,
        always_online: true,
      },
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "assistant:write",
          "chat:write",
          "im:history",
        ],
      },
    },
    settings: {
      event_subscriptions: subscriptions,
      org_deploy_enabled: false,
      socket_mode_enabled: mode === "local",
      token_rotation_enabled: false,
    },
  };
}

export async function runSlackCli(
  root: string,
  args: string[],
  mode: "local" | "remote",
): Promise<void> {
  const cliEntry = process.argv[1];
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("slack", args, {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        ...(cliEntry
          ? {
              OPENCOMPUTER_SLACK_CLI_ENTRY: cliEntry,
              OPENCOMPUTER_SLACK_NODE_EXECUTABLE: process.execPath,
            }
          : {}),
        OPENCOMPUTER_SLACK_MODE: mode,
      },
    });
    child.once("error", (error) => {
      reject(
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? new Error(
              "Slack CLI is required. Install it from https://docs.slack.dev/tools/slack-cli/.",
            )
          : error,
      );
    });
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        reject(
          new Error(
            `Slack CLI exited ${signal ? `with ${signal}` : `with code ${String(code)}`}`,
          ),
        );
      }
    });
  });
}

export async function captureLocalSlackState(
  root: string,
): Promise<LocalSlackState> {
  const candidates = [
    resolve(root, ".slack", "apps.dev.json"),
    resolve(root, ".slack", "apps.json"),
  ];
  for (const path of candidates) {
    if (!(await exists(path))) continue;
    const parsed = JSON.parse(await readFile(path, "utf8")) as SlackAppsFile;
    const entries = parsed.apps
      ? Object.values(parsed.apps)
      : Object.values(parsed).filter(
          (entry): entry is SlackAppEntry =>
            Boolean(
              entry &&
                typeof entry === "object" &&
                "app_id" in entry &&
                "team_id" in entry,
            ),
        );
    const selected =
      entries.find((entry) => entry.team_domain === parsed.default) ??
      entries[0];
    if (selected?.app_id && selected.team_id) {
      const state: LocalSlackState = {
        version: 1,
        appId: selected.app_id,
        teamId: selected.team_id,
        teamName: selected.team_domain,
      };
      const output = localSlackStatePath(root);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(state, null, 2)}\n`, {
        mode: 0o600,
      });
      return state;
    }
  }
  throw new Error("Slack CLI did not persist the local app installation.");
}
