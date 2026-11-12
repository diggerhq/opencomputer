import { fileURLToPath, URL } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

import { fakeWorkerdRuntime } from "./test/fixtures/fake-workerd-runtime.mjs";
import { fakeComputerOutbound, fakeComputerPlatform } from "./test/fixtures/computer-fakes.mjs";
import { artifactBundle, mockModel } from "./test/fixtures/memory-integrated-fixture.mjs";
import {
  artifactBundle as commandArtifactBundle,
  fakeSandbox,
  mockModel as commandMockModel,
} from "./test/fixtures/command-integrated-fixture.mjs";
import {
  artifactBundle as linearAskArtifactBundle,
  mockModel as linearAskModel,
} from "./test/fixtures/linear-ask-integrated-fixture.mjs";

// The checked-in egress registry is empty (the exits are deployment
// configuration); tests of the exits run against a fixture.
const egressRegistryFixture = {
  alias: [
    {
      find: /^.*\/egress-registry\.json$/,
      replacement: fileURLToPath(new URL("./test/fixtures/egress-registry.json", import.meta.url)),
    },
  ],
};

export default defineConfig({
  test: {
    exclude: ["**/.blue/**", "**/node_modules/**", "**/dist/**"],
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./wrangler.managed-session-workerd-test.jsonc",
            },
            miniflare: {
              serviceBindings: {
                WORKERD_RUNTIME: fakeWorkerdRuntime,
              },
            },
          }),
        ],
        test: {
          name: "managed-session-workerd",
          include: [
            "test/managed-session-workerd.test.ts",
            "test/questions.test.ts",
            "test/consult.test.ts",
            "test/session-creation-intent.test.ts",
            "test/template-runtime-parity.test.ts",
          ],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./wrangler.workerd-memory-test.jsonc",
            },
          }),
        ],
        test: {
          name: "workerd-memory",
          include: [
            "test/workerd-memory.test.ts",
            "test/workerd-result.test.ts",
            "test/workerd-schema.test.ts",
          ],
        },
      },
      {
        // Edge, Session DO, real Workerd host, real Memory DO and the public
        // session events in one worker; the model is scripted, the sandbox
        // refuses every call, and nothing reaches the network.
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./wrangler.memory-integrated-test.jsonc",
            },
            miniflare: {
              serviceBindings: {
                ARTIFACTS: async () => new Response(artifactBundle),
                SANDBOX: async () =>
                  Response.json(
                    { error: "memory operations must not reach the sandbox" },
                    { status: 500 },
                  ),
              },
              outboundService: mockModel,
            },
          }),
        ],
        test: {
          name: "memory-integrated",
          include: ["test/integrated-memory.test.ts"],
          testTimeout: 60_000,
        },
      },
      {
        // Edge, Session DO and the real Workerd host with a fake computer
        // behind the SANDBOX binding: command timeouts, the shell routing,
        // the lifetime ceiling and the reporting deadline, end to end.
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./wrangler.commands-integrated-test.jsonc",
            },
            miniflare: {
              serviceBindings: {
                ARTIFACTS: async () => new Response(commandArtifactBundle),
                SANDBOX: fakeSandbox,
              },
              outboundService: commandMockModel,
            },
          }),
        ],
        test: {
          name: "commands-integrated",
          include: ["test/integrated-commands.test.ts"],
          testTimeout: 60_000,
        },
      },
      {
        // Work 037 Phase 2a: the Linear fault matrix through the edge route,
        // the Account object's ledger and alarm, the Session object and its
        // activity queue, with the fake Workerd runtime and a fake Linear API
        // (a fetch stub) fed from the spike's recorded deliveries.
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./wrangler.managed-session-workerd-test.jsonc",
            },
            miniflare: {
              bindings: {
                BLUE_LINEAR_OAUTH_REDIRECT_URI:
                  "https://api.example/api/managed-agents/linear/callback",
              },
              serviceBindings: {
                WORKERD_RUNTIME: fakeWorkerdRuntime,
              },
            },
          }),
        ],
        test: {
          name: "linear-fault-matrix",
          include: ["test/linear-fault-matrix.test.ts"],
          testTimeout: 60_000,
        },
      },
      {
        // Work 037 Phase 2a: one Linear-started `ask` end to end on the real
        // Workerd host (the real OpenCode loop against a scripted model).
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./wrangler.memory-integrated-test.jsonc",
            },
            miniflare: {
              bindings: {
                BLUE_LINEAR_OAUTH_REDIRECT_URI:
                  "https://api.example/api/managed-agents/linear/callback",
              },
              serviceBindings: {
                ARTIFACTS: async () => new Response(linearAskArtifactBundle),
                SANDBOX: async () =>
                  Response.json(
                    { error: "the ask test must not reach the sandbox" },
                    { status: 500 },
                  ),
              },
              outboundService: linearAskModel,
            },
          }),
        ],
        test: {
          name: "linear-ask-integrated",
          include: ["test/linear-ask-integrated.test.ts"],
          testTimeout: 60_000,
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath:
                "./spikes/do-first-session/wrangler.full-example.jsonc",
            },
          }),
        ],
        test: {
          name: "do-first-session-full-example",
          include: ["test/do-first-session-full-example.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./spikes/do-first-session/wrangler.jsonc",
            },
          }),
        ],
        test: {
          name: "do-first-session-spike",
          include: ["test/do-first-session-spike.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./wrangler.jsonc",
            },
          }),
        ],
        test: {
          name: "worker",
          include: [
            "test/session.test.ts",
            "test/single-environment-project.test.ts",
            "test/slack-setup-flow.test.ts",
            "test/linear-connections.test.ts",
              "test/session-creation-intent.test.ts",
            "test/session-listing.test.ts",
            "test/template-inspection.test.ts",
            "test/tool-identity-events.test.ts",
            "test/tenant-secrets.test.ts",
            "test/database-do.test.ts",
            "test/database-routes.test.ts",
            "test/linear-ingress.test.ts",
            "test/linear-activities-do.test.ts",
            "test/computer-service-connections.test.ts",
          ],
        },
      },
      {
        // Work 052: the computer's routes, Durable Object, host WebSocket and
        // Slack app through the edge Worker, with an in-memory cloud behind
        // the platform binding and Slack answered by a fake.
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./wrangler.jsonc",
            },
            miniflare: {
              bindings: {
                COMPUTER_HOST_TOKEN_KEY: "test-computer-host-token-key",
                COMPUTER_HOST_GATEWAY_URL: "wss://managedagents.test",
                COMPUTER_PUBLIC_ORIGIN: "https://app.example",
                SLACK_COMPUTER_CLIENT_ID: "111.222",
                SLACK_COMPUTER_CLIENT_SECRET: "computer-client-secret",
                SLACK_COMPUTER_SIGNING_SECRET: "computer-signing-secret",
                SLACK_COMPUTER_SCOPES: "app_mentions:read,chat:write",
                COMPUTER_ANTHROPIC_API_KEY: "sk-ant-test",
                // Work 054: the var without the token is telemetry off; the routes test checks nothing is sent.
                // Its own host: the fake's posts are shared with the computer-telemetry project.
                TINYBIRD_API_URL: "https://off.tinybird.test",
              },
              serviceBindings: {
                RUNTIMES: fakeComputerPlatform,
              },
              outboundService: fakeComputerOutbound,
            },
          }),
        ],
        test: {
          name: "computer",
          include: ["test/computer-routes.test.ts", "test/computer-operator.test.ts", "test/computer-pool-probe-do.test.ts", "test/computer-agent-routes.test.ts", "test/computer-size.test.ts", "test/computer-spawn.test.ts", "test/computer-threads.test.ts", "test/computer-queue.test.ts", "test/computer-disk.test.ts", "test/computer-model-access-do.test.ts", "test/computer-hosted-do.test.ts"],
        },
      },
      {
        // Work 054: the computer gateway's telemetry with Tinybird configured
        // (a fake behind the outbound service) and a host socket.
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./wrangler.jsonc",
            },
            miniflare: {
              bindings: {
                COMPUTER_HOST_TOKEN_KEY: "test-computer-host-token-key",
                COMPUTER_HOST_GATEWAY_URL: "wss://managedagents.test",
                COMPUTER_PUBLIC_ORIGIN: "https://app.example",
                SLACK_COMPUTER_CLIENT_ID: "111.222",
                SLACK_COMPUTER_CLIENT_SECRET: "computer-client-secret",
                SLACK_COMPUTER_SIGNING_SECRET: "computer-signing-secret",
                SLACK_COMPUTER_SCOPES: "app_mentions:read,chat:write",
                COMPUTER_ANTHROPIC_API_KEY: "sk-ant-test",
                TINYBIRD_API_URL: "https://tinybird.test",
                TINYBIRD_APPEND_TOKEN: "p.test-append",
              },
              serviceBindings: {
                RUNTIMES: fakeComputerPlatform,
              },
              outboundService: fakeComputerOutbound,
            },
          }),
        ],
        test: {
          name: "computer-telemetry",
          include: ["test/computer-telemetry-flow.test.ts"],
          testTimeout: 30_000,
        },
      },
      {
        // Work 052, warm pool: the same Worker with COMPUTER_POOL_SIZE set,
        // so the pool object refills, pool computers connect and
        // organizations claim them.
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./wrangler.jsonc",
            },
            miniflare: {
              bindings: {
                COMPUTER_HOST_TOKEN_KEY: "test-computer-host-token-key",
                COMPUTER_HOST_GATEWAY_URL: "wss://managedagents.test",
                COMPUTER_PUBLIC_ORIGIN: "https://app.example",
                SLACK_COMPUTER_CLIENT_ID: "111.222",
                SLACK_COMPUTER_CLIENT_SECRET: "computer-client-secret",
                SLACK_COMPUTER_SIGNING_SECRET: "computer-signing-secret",
                SLACK_COMPUTER_SCOPES: "app_mentions:read,chat:write",
                COMPUTER_ANTHROPIC_API_KEY: "sk-ant-test",
                COMPUTER_POOL_SIZE: "2",
              },
              serviceBindings: {
                RUNTIMES: fakeComputerPlatform,
              },
              outboundService: fakeComputerOutbound,
            },
          }),
        ],
        test: {
          name: "computer-pool",
          include: ["test/computer-pool-routes.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./wrangler.jsonc",
            },
          }),
        ],
        test: {
          name: "memory",
          include: ["test/memory-*.test.ts"],
        },
      },
      {
        resolve: egressRegistryFixture,
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./wrangler.platform.jsonc",
            },
          }),
        ],
        test: {
          name: "platform-admission",
          // The platform Worker's modules import cloudflare:workers, so
          // tests that load them run here rather than under node.
          include: [
            "test/tool-sandbox-resolve.test.ts",
            "test/deployment-egress.test.ts",
          ],
        },
      },
      {
        // Work 074: the previews Worker and its name objects, alone.
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./wrangler.previews-test.jsonc",
            },
          }),
        ],
        test: {
          name: "previews",
          include: ["test/previews-do.test.ts"],
        },
      },
      {
        // Work 084: the SessionLog Durable Object on its own instance. Kept out of the computer
        // project, whose files share fakeComputerOutbound's recorded Slack calls.
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./wrangler.jsonc",
            },
          }),
        ],
        test: {
          name: "session-log",
          include: ["test/session-log.test.ts"],
        },
      },
      {
        // Work 084: the wire Worker alone, with a local KV namespace; the
        // tunnel is a fetch stub in the tests.
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./wrangler.wire-test.jsonc",
            },
          }),
        ],
        test: {
          name: "wire",
          include: ["test/wire-*.test.ts"],
        },
      },
      {
        resolve: egressRegistryFixture,
        test: {
          name: "node",
          environment: "node",
          include: [
            "test/auth.test.ts",
            "test/computer-grants.test.ts",
            "test/computer-model-access.test.ts",
            "test/computer-model-profiles.test.ts",
            "test/computer-disk-growth.test.ts",
            "test/deployment-region.test.ts",
            "test/session-runtime-selection.test.ts",
            "test/egress-exit.test.ts",
            "test/egress-exits.test.ts",
            "test/egress-tunnel.test.ts",
            "test/project-scope.test.ts",
            "test/ask-input.test.ts",
            "test/billing-admission.test.ts",
            "test/managed-model-fallback.test.ts",
            "test/workspace-export.test.ts",
            "test/code-tools.test.ts",
            "test/command-unit.test.ts",
            "test/tool-identity.test.ts",
            "test/dev-manager.test.ts",
            "test/local-control-plane.test.ts",
            "test/model-gateway.test.ts",
            "test/model-route.test.ts",
            "test/opencode-config.test.ts",
            "test/opencode2-harness.test.ts",
            "test/opencode2-reactive-plugin.test.ts",
            "test/cloud-reactive-plugin-memory.test.ts",
            "test/production-platform-config.test.ts",
            "test/reactive-agent.test.ts",
            "test/runtime-profiles.test.ts",
            "test/runtime-failure.test.ts",
            "test/sandbox-adapter.test.ts",
            "test/modal-provider.test.ts",
            "test/sandbox-sweep.test.ts",
            "test/modal-session-runtime.test.ts",
            "test/model-catalog.test.ts",
            "test/session-result.test.ts",
            "test/structured-input.test.ts",
            "test/templates.test.ts",
            "test/template-model-parity.test.ts",
            "test/composio-connection.test.ts",
            "test/google-connection.test.ts",
            "test/github.test.ts",
            "test/previews.test.ts",
            "test/computer-previews.test.ts",
            "test/computer-sessions-api.test.ts",
          "test/git-deploy.test.ts",
            "test/automation-repository.test.ts",
            "test/github-credential.test.ts",
            "test/slack-progress.test.ts",
            "test/slack-manifest.test.ts",
            "test/slack.test.ts",
            "test/slack-setup.test.ts",
            "test/template-trigger-builder.test.ts",
            "test/tool-execution-policy.test.ts",
            "test/tool-events.test.ts",
            "test/workerd-routing.test.ts",
            "test/workerd-mcp.test.ts",
            "test/workerd-model-retry.test.ts",
            "test/workerd-gated-tools.test.ts",
            "test/workerd-skills.test.ts",
            "test/skill-tool.test.ts",
            "test/webhook-input.test.ts",
            "test/channel-adapters.test.ts",
            "test/linear-adapter.test.ts",
            "test/linear-activities.test.ts",
            "test/computer-azure.test.ts",
            "test/computer-billing.test.ts",
            "test/computer-lifecycle.test.ts",
            "test/computer-pool.test.ts",
            "test/computer-pool-probe.test.ts",
            "test/computer-token-check.test.ts",
            "test/computer-secrets.test.ts", "test/computer-secrets-scopes.test.ts",
            "test/computer-connections.test.ts",
            "test/computer-model-subscriptions.test.ts",
            "test/computer-codex-subscriptions.test.ts",
            "test/computer-agent-connect.test.ts",
            "test/computer-connect-codes.test.ts",
            "test/computer-units.test.ts",
            "test/session-fold.test.ts",
            "test/computer-calvin-contract.test.ts",
            "test/computer-telemetry.test.ts",
            "test/computer-api-telemetry.test.ts",
            "test/opencomputer-key.test.ts",
            "test/telemetry-emitter.test.ts",
            "test/telemetry-validate.test.ts",
            "test/serverless-latency.test.ts",
          ],
        },
      },
    ],
  },
});
