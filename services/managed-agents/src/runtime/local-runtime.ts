#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  type RuntimeEventInput,
  type RuntimeToSessionFrame,
  type SessionToRuntimeFrame,
  isRecord,
} from "../protocol.js";
import {
  createHarness,
  type Harness,
  type HarnessName,
} from "./harness.js";
import { effectiveRuntimeModel } from "../microvm/opencode-config.js";
import { parseToolInvocationIdentity } from "../tool-identity.js";
import { codeToolContext, loadCodeTools } from "./code-tools.js";
import { failedTurnData } from "./failure.js";

interface RuntimeOptions {
  edge: string;
  sessionId: string;
  token: string;
  harness: HarnessName;
  directory: string;
  model?: string;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseOptions(): RuntimeOptions {
  const edge = option("edge");
  const sessionId = option("session");
  const token = option("token");
  const harness = option("harness") ?? "mock";
  if (!edge || !sessionId || !token) {
    throw new Error("--edge, --session, and --token are required");
  }
  if (
    harness !== "mock" &&
    harness !== "opencode" &&
    harness !== "opencode2-reactive"
  ) {
    throw new Error("--harness must be mock, opencode, or opencode2-reactive");
  }
  return {
    edge: edge.replace(/\/$/, ""),
    sessionId,
    token,
    harness,
    directory: option("directory") ?? process.cwd(),
    ...(option("model") ? { model: option("model") } : {}),
  };
}

function websocketUrl(edge: string, sessionId: string, token: string): string {
  const url = new URL(
    `/v1/sessions/${encodeURIComponent(sessionId)}/connect`,
    edge,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("role", "runtime");
  url.searchParams.set("token", token);
  return url.toString();
}

async function main(): Promise<void> {
  const options = parseOptions();
  // Only if the supervisor has not already supplied them. It passes the local
  // egress proxy, which routes a managed-egress call to the handler that
  // serves one; this fallback points at `/connections`, which serves provider
  // actions and answers "Invalid API request" to anything else. Overwriting
  // what the supervisor set made every outbound call from a gated tool's
  // `apply` fail without ever reaching the API.
  process.env.BLUE_CONNECTIONS_URL ??=
    `${options.edge}/v1/sessions/${encodeURIComponent(options.sessionId)}/connections`;
  process.env.BLUE_CONNECTION_TOKEN ??= options.token;
  process.env.OPENCOMPUTER_CONNECTIONS_URL ??= process.env.BLUE_CONNECTIONS_URL;
  process.env.OPENCOMPUTER_CONNECTION_TOKEN ??= process.env.BLUE_CONNECTION_TOKEN;
  let harness: Harness | undefined;
  let harnessStart: Promise<void> | undefined;

  const socket = new WebSocket(
    websocketUrl(options.edge, options.sessionId, options.token),
  );
  let epoch: number | undefined;
  let frameNumber = 0;
  let running = Promise.resolve();

  const startHarness = (model?: string): Promise<void> => {
    if (!harnessStart) {
      harness = createHarness(options.harness, options.directory, model);
      harnessStart = harness.start();
    }
    return harnessStart;
  };

  const send = (frame: RuntimeToSessionFrame): void => {
    socket.send(JSON.stringify(frame));
  };

  const sendEvents = (
    turnId: string,
    events: RuntimeEventInput[],
  ): void => {
    if (epoch === undefined) {
      throw new Error("Runtime has not received its epoch");
    }
    frameNumber += 1;
    send({
      type: "event.batch",
      epoch,
      frameId: `${process.pid}-${frameNumber}`,
      turnId,
      events,
    });
  };

  socket.addEventListener("message", (message) => {
    void (async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (!isRecord(parsed) || typeof parsed.type !== "string") {
        return;
      }
      const frame = parsed as unknown as SessionToRuntimeFrame;
      if (frame.type === "runtime.welcome") {
        epoch = frame.epoch;
        if (options.harness !== "mock") {
          send({
            type: "model.configuration.request",
            epoch,
          });
          return;
        }
        await startHarness(process.env.BLUE_MODEL);
        send({ type: "runtime.ready", epoch });
        process.stdout.write(
          `runtime connected: ${options.sessionId} (${options.harness})\n`,
        );
        return;
      }
      if (frame.type === "model.configuration") {
        const model = effectiveRuntimeModel(options.model, frame.model);
        process.env.BLUE_MODEL = model;
        await startHarness(model);
        if (epoch === undefined) {
          throw new Error("Model configuration arrived before runtime epoch");
        }
        send({ type: "runtime.ready", epoch });
        process.stdout.write(
          `runtime connected: ${options.sessionId} (${options.harness})\n`,
        );
        return;
      }
      if (frame.type === "turn.cancel") {
        await harness?.interrupt();
        return;
      }
      if (frame.type === "tool.apply") {
        // Not a turn. A person approved specific arguments, so those exact
        // arguments are what runs — no prompt, no model, no chance of the
        // write drifting from the card somebody said yes to.
        const applyId = frame.applyId;
        try {
          const manifestPath = resolve(
            options.directory,
            ".opencomputer",
            "reactive.json",
          );
          const manifest = JSON.parse(
            await readFile(manifestPath, "utf8"),
          ) as {
            tools?: string[];
            toolModules?: string[];
            gatedTools?: string[];
          };
          const definitions = await loadCodeTools(
            manifestPath,
            manifest.toolModules ?? [],
            new Set(manifest.tools ?? []),
            new Set(manifest.gatedTools ?? []),
          );
          const definition = definitions.find(
            (candidate) => candidate.id === frame.toolId,
          );
          if (!definition?.apply) {
            throw new Error(
              `The artifact has no gated tool ${JSON.stringify(frame.toolId)}`,
            );
          }
          // An apply has no model tool call behind it; the approval is the
          // stable identity (message and call), and re-dispatching the same
          // one is the retry it is meant to be stable across. The Session
          // object sends it whole; a frame without one is refused rather
          // than attributed to guesswork.
          const identity = parseToolInvocationIdentity(frame.identity);
          if (!identity || identity.sessionId !== options.sessionId) {
            throw new Error(
              "The write was refused: it carried no host identity for this session",
            );
          }
          const result = await definition.apply({
            ...codeToolContext(identity, frame.input, {
              reportProgress: async () => undefined,
            }),
            decision: frame.decision,
          });
          send({
            type: "tool.applied",
            epoch: epoch ?? 0,
            applyId,
            ok: true,
            result: (result ?? null) as never,
          });
        } catch (error) {
          send({
            type: "tool.applied",
            epoch: epoch ?? 0,
            applyId,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (frame.type === "turn.steer") {
        try {
          if (!harness) throw new Error("Runtime harness is not ready");
          await harness.steer(frame.input);
          sendEvents(frame.turnId, [{ type: "turn.completed", data: {} }]);
        } catch (error) {
          sendEvents(frame.turnId, [
            {
              type: "turn.failed",
              data: failedTurnData(error),
            },
          ]);
        }
        return;
      }
      if (frame.type !== "turn.start") {
        return;
      }

      running = running.then(async () => {
        try {
          if (!harness) {
            throw new Error("Runtime harness is not ready");
          }
          for await (const event of harness.run({ ...frame, epoch })) {
            sendEvents(frame.turnId, [event]);
          }
          // A turn that asked carries its question on its completion, so
          // the session commits both in one settlement.
          const question = harness.takeQuestion?.();
          sendEvents(frame.turnId, [
            { type: "turn.completed", data: question ? { question: { ...question } } : {} },
          ]);
        } catch (error) {
          const failure = failedTurnData(error);
          const message = String(failure.message);
          sendEvents(frame.turnId, [
            {
              type: "runtime.log",
              data: {
                level: "error",
                stream: "system",
                message: message.slice(0, 16_384),
              },
            },
            {
              type: "turn.failed",
              data: failure,
            },
          ]);
        }
      });
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `managed-agent runtime: ${message}\n`,
      );
      socket.close(
        4000,
        Buffer.byteLength(message, "utf8") <= 100
          ? message
          : "Runtime initialization failed; see the managed-agent runtime logs",
      );
    });
  });

  const heartbeat = setInterval(() => {
    if (epoch !== undefined && socket.readyState === WebSocket.OPEN) {
      send({ type: "runtime.heartbeat", epoch });
    }
  }, 15_000);

  const stop = async (): Promise<void> => {
    clearInterval(heartbeat);
    await running;
    await harness?.close();
    socket.close(1000, "Runtime stopped");
  };

  process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("close", () => resolve());
    socket.addEventListener("error", () =>
      reject(new Error("Runtime WebSocket connection failed")),
    );
  });
  clearInterval(heartbeat);
  await harness?.close();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `managed-agent runtime: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
