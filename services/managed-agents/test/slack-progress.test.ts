import { describe, expect, it } from "vitest";

import {
  SlackProgress,
  describeSlackTool,
  truncateSlackStatus,
  type SlackTaskUpdate,
} from "../src/channels/slack-progress.js";
import type { AgentEvent } from "../src/protocol.js";

function event(
  type: AgentEvent["type"],
  data: Record<string, unknown>,
): AgentEvent {
  return {
    id: "event",
    seq: 1,
    timestamp: new Date(0).toISOString(),
    protocolVersion: 2,
    accountId: "local",
    agentId: "local/test",
    deploymentId: "development",
    sessionId: "session",
    turnId: "turn",
    type,
    data,
  };
}

describe("Slack progress", () => {
  it("normalizes and truncates native Slack statuses", () => {
    expect(truncateSlackStatus("Reading **the docs**")).toBe(
      "Reading the docs",
    );
    expect(truncateSlackStatus("x".repeat(80))).toHaveLength(50);
    expect(truncateSlackStatus("x".repeat(80))).toMatch(/\.\.\.$/);
  });

  it("describes tool calls using their most useful argument", () => {
    expect(
      describeSlackTool(
        event("tool.started", {
          tool: "grep",
          input: { pattern: "SlackProgress", path: "src" },
        }),
      ),
    ).toBe("grep SlackProgress");
  });

  it("describes a consult by the member it asks", () => {
    expect(
      describeSlackTool(
        event("tool.started", {
          tool: "consult",
          input: { agent: "categoriser", prompt: "open tickets?" },
        }),
      ),
    ).toBe("Consulting categoriser...");
    expect(
      describeSlackTool(event("tool.started", { tool: "consult", input: {} })),
    ).toBe("Consulting...");
  });

  /** Let the update in flight settle and the next one start. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("sends lifecycle, tool, and response updates in order when each lands", async () => {
    const statuses: string[] = [];
    const progress = new SlackProgress(async ({ status }) => {
      statuses.push(status);
    });

    progress.start();
    await settle();
    progress.runtimeStarting();
    await settle();
    progress.runtimeReady();
    await settle();
    progress.handle(
      event("tool.started", {
        tool: "read",
        input: { filePath: "src/edge/session-do.ts" },
      }),
    );
    await settle();
    progress.handle(event("message.delta", { text: "Done" }));
    await progress.stop();

    expect(statuses).toEqual([
      "Thinking...",
      "Starting OpenCode...",
      "Working...",
      "read src/edge/session-do.ts",
      "Writing response...",
    ]);
  });

  it("keeps one request in flight and only the latest status behind it", async () => {
    const statuses: string[] = [];
    let release = () => {};
    const progress = new SlackProgress(async ({ status }) => {
      statuses.push(status);
      if (status === "Thinking...") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });

    progress.start();
    progress.runtimeStarting();
    progress.runtimeReady();
    progress.handle(event("tool.started", { tool: "grep", input: { pattern: "x" } }));
    // Nothing else went out while the first request was still in flight.
    expect(statuses).toEqual(["Thinking..."]);
    release();
    await settle();
    // The lines in between were never worth a request; the latest one was.
    expect(statuses).toEqual(["Thinking...", "grep x"]);
    await progress.stop();
  });

  it("streams activity as task cards that collapse on settle", async () => {
    const appended: SlackTaskUpdate[][] = [];
    let streamStopped = false;
    const progress = new SlackProgress(
      async () => {},
      {
        append: async (chunks) => {
          appended.push([...chunks]);
        },
        stop: async () => {
          streamStopped = true;
        },
      },
    );

    progress.start();
    await settle();
    // The first reasoning line opens a card and edits it in place as the
    // line grows.
    progress.handle(event("reasoning.delta", { text: "Looking at the" }));
    await settle();
    progress.handle(event("reasoning.delta", { text: " tests now" }));
    await settle();
    progress.handle(
      event("tool.started", { tool: "bash", input: { command: "npm test" } }),
    );
    await settle();
    progress.handle(event("message.delta", { text: "Done" }));
    await progress.stop();

    const flat = appended.flat();
    // The three opening steps lead the plan, already complete or in flight.
    expect(flat.slice(0, 3)).toEqual([
      { type: "task_update", id: "step-1", title: "Reading your request...", status: "complete" },
      { type: "task_update", id: "step-2", title: "Inspecting the workspace...", status: "complete" },
      { type: "task_update", id: "step-3", title: "Planning the next step...", status: "in_progress" },
    ]);
    const byId = (id: string) => flat.filter((chunk) => chunk.id === id);
    // Planning completed when the reasoning card opened.
    expect(byId("step-3").at(-1)).toMatchObject({ status: "complete" });
    // The growing line renamed its card rather than opening a new one.
    expect(byId("step-4")).toEqual([
      { type: "task_update", id: "step-4", title: "Looking at the", status: "in_progress" },
      { type: "task_update", id: "step-4", title: "Looking at the tests now", status: "in_progress" },
      expect.objectContaining({ status: "complete" }),
    ]);
    // Each new step completes the open card before starting its own.
    expect(byId("step-5")).toEqual([
      { type: "task_update", id: "step-5", title: "bash npm test", status: "in_progress" },
      expect.objectContaining({ status: "complete" }),
    ]);
    expect(byId("step-6")).toEqual([
      { type: "task_update", id: "step-6", title: "Writing response...", status: "in_progress" },
      expect.objectContaining({ status: "complete" }),
    ]);
    // Settle completes the last card, then the stream finalizes.
    expect(streamStopped).toBe(true);
  });

  it("keeps going without the stream when appending fails", async () => {
    const statuses: string[] = [];
    let attempts = 0;
    const progress = new SlackProgress(
      async ({ status }) => {
        statuses.push(status);
      },
      {
        append: async () => {
          attempts += 1;
          throw new Error("stream unavailable");
        },
        stop: async () => {},
      },
    );

    progress.runtimeStarting();
    await settle();
    progress.handle(
      event("tool.started", { tool: "bash", input: { command: "ls" } }),
    );
    await settle();
    await progress.stop({ clear: true });

    // One failed append disabled the stream; the shimmer still ran.
    expect(attempts).toBe(1);
    expect(statuses).toContain("Starting OpenCode...");
    expect(statuses.at(-1)).toBe("");
  });

  it("stops after the request in flight, dropping what was queued behind it", async () => {
    const statuses: string[] = [];
    let release = () => {};
    const progress = new SlackProgress(async ({ status }) => {
      statuses.push(status);
      if (status === "Working...") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });

    progress.runtimeReady();
    progress.handle(event("tool.started", { tool: "read", input: { path: "a" } }));
    const stopped = progress.stop({ clear: true });
    let done = false;
    void stopped.then(() => {
      done = true;
    });
    await settle();
    // Waiting on the one in flight, not on the tool line queued behind it.
    expect(done).toBe(false);
    release();
    await stopped;
    expect(statuses).toEqual(["Working...", ""]);
  });
});
