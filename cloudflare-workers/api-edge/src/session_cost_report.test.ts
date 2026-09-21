import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sessionCostDetail,
  sessionCostReport,
  type SessionCostReportEnv,
} from "./session_cost_report";

function testEnv(row: Record<string, unknown> | null): SessionCostReportEnv {
  return {
    OC_MANAGED_AGENTS_SECRET: "managed-secret",
    MANAGED_AGENTS_API_URL: "https://managedagents.test",
    OPENCOMPUTER_DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => row,
        }),
      }),
    } as unknown as D1Database,
  };
}

describe("sessionCostReport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns prompt-free per-session costs reconciled to the D1 watermark", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({
        sessions: [
          {
            id: "session-low",
            agentId: "researcher",
            deploymentId: "dep-1",
            projectId: "project-1",
            projectName: "Research",
            source: "channel",
            status: "idle",
            title: "customer prompt must not leave the operator report",
            createdAt: "2026-09-18T10:00:00.000Z",
            updatedAt: "2026-09-18T10:05:00.000Z",
            modelCalls: 2,
            modelProviderCostUsd: 0.25,
            modelUsage: [
              { timestamp: "2026-09-18T10:01:00.000Z", costUsd: 0.25 },
            ],
            runtimeSecondsByTier: { "2gb_1vcpu": 40 },
          },
          {
            id: "session-high",
            agentId: "builder",
            deploymentId: "dep-2",
            source: "api",
            status: "running",
            createdAt: "2026-09-18T11:00:00.000Z",
            updatedAt: "2026-09-18T11:05:00.000Z",
            modelCalls: 3,
            modelProviderCostUsd: 1.5,
            modelUsage: [],
            runtimeSecondsByTier: {},
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await sessionCostReport(
      testEnv({
        org_name: "Example workspace",
        model_markup_bps: 1000,
        committed_micro: 2_000_000,
      }),
      "org-example",
      100,
    );

    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      orgId: "org-example",
      orgName: "Example workspace",
      coverage: {
        requestedSessionLimit: 100,
        returnedSessions: 2,
        possiblyTruncated: false,
      },
      reconciliation: {
        attributedProviderCostUsd: 1.75,
        committedProviderCostUsd: 2,
        unattributedProviderCostUsd: 0.25,
        markupBps: 1000,
        attributedBilledCostUsd: 1.9250000000000003,
        committedBilledCostUsd: 2.2,
      },
    });
    expect(body.sessions).toEqual([
      expect.objectContaining({ id: "session-high", modelProviderCostUsd: 1.5 }),
      expect.objectContaining({ id: "session-low", modelProviderCostUsd: 0.25 }),
    ]);
    expect(JSON.stringify(body)).not.toContain("customer prompt");
    expect(JSON.stringify(body)).not.toContain("modelUsage");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [target, init] = fetchSpy.mock.calls[0] as unknown as [
      URL | RequestInfo,
      RequestInit,
    ];
    expect(String(target)).toBe(
      "https://managedagents.test/v1/billing/sessions?limit=100",
    );
    expect(
      new Headers(init.headers).get("x-opencomputer-agent-token"),
    ).toBeTruthy();
  });

  it("returns 404 without calling managedagents when the org is absent", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const response = await sessionCostReport(testEnv(null), "missing", 100);
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("sessionCostDetail", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns only model routes and token accounting, never message content", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({
        events: [
          {
            timestamp: "2026-09-18T19:40:01.000Z",
            turnId: "turn-1",
            type: "message.received",
            data: { text: "private scheduled prompt" },
          },
          {
            timestamp: "2026-09-18T19:40:02.000Z",
            turnId: "turn-1",
            type: "model.route_resolved",
            data: {
              providerCallId: "private-call-id",
              requested: { provider: "anthropic", model: "claude-sonnet" },
              effective: { provider: "anthropic", model: "claude-sonnet" },
              runtime: "claude",
              access: { type: "managed", connectionId: "private-connection" },
              openComputerModelChargeUsd: null,
            },
          },
          {
            timestamp: "2026-09-18T19:40:03.000Z",
            turnId: "turn-1",
            type: "usage.recorded",
            data: {
              provider: "openrouter",
              model: "anthropic/claude-sonnet",
              inputTokens: 12_000,
              outputTokens: 500,
              reasoningTokens: 10,
              cachedTokens: 2_000,
              cacheWriteTokens: 100,
              costUsd: 0,
              payer: "user",
              prompt: "must not escape",
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await sessionCostDetail(
      testEnv(null),
      "org-example",
      "session-example",
    );
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      orgId: "org-example",
      sessionId: "session-example",
      accountingEvents: [
        {
          type: "model.route_resolved",
          data: {
            effective: { provider: "anthropic", model: "claude-sonnet" },
            access: { type: "managed" },
            openComputerModelChargeUsd: null,
          },
        },
        {
          type: "usage.recorded",
          data: {
            model: "anthropic/claude-sonnet",
            inputTokens: 12_000,
            outputTokens: 500,
            costUsd: 0,
          },
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("private scheduled prompt");
    expect(JSON.stringify(body)).not.toContain("private-call-id");
    expect(JSON.stringify(body)).not.toContain("private-connection");
    expect(JSON.stringify(body)).not.toContain("must not escape");
  });
});
