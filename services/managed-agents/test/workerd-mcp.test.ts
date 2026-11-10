import { describe, expect, it } from "vitest";

import {
  safeMcpDiagnosticError,
  workerdDatabaseMcpServer,
  workerdMcpServers,
  workerdMcpToolExposure,
  workerdMcpToolIsEnabled,
} from "../src/workerd-runtime/mcp.js";

describe("Workerd MCP registration", () => {
  it("routes the system database MCP through the authenticated edge", () => {
    expect(
      workerdDatabaseMcpServer({
        edge: "https://managedagents.test/",
        managedSessionId: "session/one",
        runtimeToken: "runtime-secret",
      }),
    ).toEqual({
      type: "remote",
      url: "https://managedagents.test/v1/sessions/session%2Fone/database/mcp",
      headers: { authorization: "Bearer runtime-secret" },
      oauth: false,
    });
  });

  it("routes a connected Kernel server through managed egress", () => {
    expect(
      workerdMcpServers(
        ["kernel"],
        [
          {
            id: "kernel",
            url: "https://mcp.onkernel.com/mcp",
            connection: "kernel-mcp-auth",
          },
        ],
        {
          edge: "https://managedagents.test/",
          managedSessionId: "session/one",
          runtimeToken: "runtime-secret",
        },
      ),
    ).toEqual({
      kernel: {
        type: "remote",
        url:
          "https://managedagents.test/v1/sessions/session%2Fone/mcp/kernel-mcp-auth?path=%2Fmcp",
        headers: { authorization: "Bearer runtime-secret" },
        oauth: false,
      },
    });
  });

  it("keeps selected MCP tools and the complete-catalog bridge", () => {
    expect(workerdMcpToolIsEnabled("kernel_manage_browsers", ["kernel"], ["kernel"]))
      .toBe(true);
    expect(workerdMcpToolIsEnabled("search", ["kernel"], ["kernel"]))
      .toBe(true);
    expect(workerdMcpToolIsEnabled("execute", ["kernel"], ["kernel", "github"]))
      .toBe(false);
    expect(workerdMcpToolIsEnabled("github_search_code", ["kernel"], ["kernel", "github"]))
      .toBe(false);
  });

  it("rejects a registered server missing its packaged definition", () => {
    expect(() =>
      workerdMcpServers(["kernel"], [], {
        edge: "https://managedagents.test",
        managedSessionId: "session-one",
        runtimeToken: "runtime-secret",
      }),
    ).toThrow('MCP server "kernel" has no definition in the artifact');
  });

  it("summarizes MCP catalog exposure without logging schemas", () => {
    expect(
      workerdMcpToolExposure(
        ["execute", "search", "kernel_manage_browsers", "shell"],
        ["kernel"],
        ["kernel"],
      ),
    ).toEqual({
      availableToolCount: 4,
      codeMode: {
        searchAvailable: true,
        executeAvailable: true,
        searchRetained: true,
        executeRetained: true,
      },
      registeredToolCounts: { kernel: 1 },
    });
  });

  it("redacts bearer credentials and bounds MCP diagnostic errors", () => {
    const diagnostic = safeMcpDiagnosticError(
      `request failed with Authorization: Bearer runtime-secret ${"x".repeat(3_000)}`,
    );
    expect(diagnostic).not.toContain("runtime-secret");
    expect(diagnostic).toContain("Bearer [redacted]");
    expect(diagnostic.length).toBe(2_000);
  });
});
