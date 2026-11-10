// The fake Workerd runtime behind the `managed-session-workerd` vitest
// project: a service binding implemented in Node, so it outlives every
// Durable Object eviction the tests perform. It models what the managed
// session relies on from the real host: one live execution per runtime
// session (the turn lease; a second `/turn` while one is live is refused
// with 409 `turn_in_progress`), `/stop` ending that execution the way the
// host does (the loop interrupted, `session.execution.interrupted` on the
// stream, every dispatched operation settled or reported pending),
// `/terminate-computer` as the fallback that settles by retiring the
// computer, and typed input echoed through the render.
//
// Prompt directives, for tests only:
//   [stall Nms]              keep streaming after the first delta for N ms,
//                            or until a stop ends the stream
//   [hold-interrupt Nms]     the next /stop for this runtime session
//                            answers only after N ms
//   [fail-interrupt N]       the next N /stop calls answer 500
//   [replay-after-interrupt] the execution stays live after the stop
//                            settles, as a loop replayed at boot would;
//                            the next /turn is refused once and the next
//                            /stop clears it
//   [ops N]                  the execution has N computer operations in
//                            flight; a stop settles them at once unless
//   [hold-settlement Nms]    they settle only N ms after the first stop, or
//   [never-settle]           never (a supervisor that does not confirm);
//                            only /terminate-computer settles them then
//   [fail-terminate N]       the next N /terminate-computer calls answer 500
//   [long-progress]          22 KB of progress in one assistant message, a
//                            tool call, then a short final answer in a
//                            second assistant message
//   [result-call ID]         a `report` call with this id starts (named on
//                            input.started, input on called, one progress
//                            frame) before the stall and succeeds on the
//                            stream once the stall has run out: a result
//                            tool the managed session commits during the
//                            stall, whose stream completion is then a
//                            duplicate
//   [tool-before-stall ID]   a `sandbox_exec` call with this id starts
//                            before the stall and is never settled by the
//                            stream (a command still running when a stop
//                            lands)
//   [tool-fails ID]          a `lookup` call with this id starts and fails
//                            before the stall
//   [step-model ID]          the model OpenCode names on session.step.started
//                            (default anthropic/claude-sonnet-4.6)
//   [delay-stream Nms]       wait before delivering the first response frame
//   [model-retry N]          after the first delta, OpenCode schedules a
//                            retry of the model call (attempt N, a
//                            provider.transport failure) and the response
//                            then continues in a new assistant message;
//                            `[model-retry N host]` marks the retry as one
//                            the host granted
//   [model-fails TYPE]       after the first delta, the execution fails with
//                            a provider error of this typed class (status 502
//                            for provider.internal), the way OpenCode reports
//                            a model call that failed after its retry
//   [step-usage]             the step ends with token counts and a cost
//                            before the execution succeeds
//   [ask ID]                 once any stall has run out, an `ask` call with
//                            this id ("Which approach?", options Go/Wait):
//                            the host's question frame, the call's success,
//                            then the loop interrupted by the host, the way
//                            the Workerd runtime ends a turn that asked;
//   [ask-plain ID]           the same without options; with [ops N] the
//                            operations stay in flight after the interrupt
//                            until a /stop settles them
//   [ask-own-step]           with [ask ID]: the `ask` call is a model call
//                            of its own, a new assistant message that
//                            writes no text (the step before it ends, a
//                            step for `msg-ask` starts), the way OpenCode
//                            records a step that only calls a tool
//   [ask-context TEXT]       with [ask ID]: the `ask` call also gives
//                            `context` TEXT (what the person needs to
//                            decide, shown above the question)
//   [silent]                 the turn completes with no assistant text
//                            (an agent that chose to say nothing)
//   [consult AGENT PROMPT]   a `consult` call for member AGENT with PROMPT
//                            (default "What do you see?"): the host's
//                            consulted frame, the call's success, then the
//                            loop interrupted, the way the Workerd runtime
//                            ends a turn that consulted
//
// Tool frames follow OpenCode's own event shapes: the name travels on
// `session.tool.input.started`, the input on `session.tool.called`, the
// result as content parts on `session.tool.success`, the error as
// `{ type, message }` on `session.tool.failed`.

const encoder = new TextEncoder();

/** Live executions and pending directives by runtime session id. */
const sessions = new Map();
let created = 0;

// Test control for session creation: a delay before the runtime answers a
// creation or a sandbox-context configuration (the window in which
// concurrent admissions of one managed session can interleave), and the
// artifact digests of the creations in flight right now, so a test can
// wait until a creation has actually reached the runtime.
let creationDelayMs = 0;
const creationsInFlight = [];

function state(runtimeSessionId) {
  let entry = sessions.get(runtimeSessionId);
  if (!entry) {
    entry = {
      live: undefined,
      holdInterruptMs: 0,
      failInterrupts: 0,
      failTerminates: 0,
      calls: [],
      creation: undefined,
      computerGeneration: 1,
      computerTerminated: false,
    };
    sessions.set(runtimeSessionId, entry);
  }
  return entry;
}


function frame(type, data) {
  return `data: ${JSON.stringify({ type, data })}\n\n`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const runtimeHeaders = {
  "x-opencomputer-runtime-activation": "1",
  "x-opencomputer-runtime-boot": "boot-managed-test",
  "x-opencomputer-runtime-init-ms": "18.5",
  "x-opencomputer-runtime-age-ms": "50",
};

/** The operations of a live execution as the stop reports them right now. */
function operationsOf(live, entry) {
  const ids = Array.from({ length: live.ops }, (_value, index) => `${live.turnId ?? "turn"}-op-${String(index + 1)}`);
  if (entry.computerTerminated) {
    return { total: ids.length, settled: ids.length, pending: [] };
  }
  const pending =
    live.neverSettle || (live.settleAtMs !== undefined && Date.now() < live.settleAtMs) ? ids : [];
  return { total: ids.length, settled: ids.length - pending.length, pending };
}

export async function fakeWorkerdRuntime(request) {
  const url = new URL(request.url);
  const match = /^\/sessions\/([^/]+)\/(turn|stop|terminate-computer|sandbox-context|calls)$/.exec(url.pathname);

  // What the fake saw, for assertions from the test worker: every /turn,
  // /stop and /terminate-computer for the runtime session in order, and
  // whether an execution is live right now.
  if (request.method === "GET" && match?.[2] === "calls") {
    const entry = state(decodeURIComponent(match[1]));
    return Response.json({
      calls: entry.calls,
      creation: entry.creation ?? null,
      live: entry.live?.turnId ?? null,
      computerGeneration: entry.computerGeneration,
      computerTerminated: entry.computerTerminated,
    });
  }

  if (url.pathname === "/__test/creation") {
    if (request.method === "POST") {
      const body = await request.json();
      creationDelayMs = Math.max(0, Number(body.delayMs ?? 0));
    }
    return Response.json({ delayMs: creationDelayMs, inFlight: [...creationsInFlight] });
  }

  if (request.method === "POST" && url.pathname === "/sessions") {
    const input = await request.json();
    if (!input.deployment?.artifact?.digest) {
      return Response.json({ error: "deployment_required" }, { status: 400 });
    }
    const digest = input.deployment.artifact.digest;
    creationsInFlight.push(digest);
    try {
      if (creationDelayMs) await sleep(creationDelayMs);
    } finally {
      creationsInFlight.splice(creationsInFlight.indexOf(digest), 1);
    }
    created += 1;
    state(`runtime-managed-${created}`).creation = {
      ...input,
      locationHint: request.headers.get("x-opencomputer-location-hint"),
    };
    return Response.json(
      { id: `opencode-managed-${created}` },
      {
        status: 201,
        headers: {
          "x-opencomputer-session": `runtime-managed-${created}`,
          "x-opencomputer-runtime-activation": "1",
          "x-opencomputer-runtime-boot": "boot-managed-test",
          "x-opencomputer-runtime-init-ms": "18.5",
          "x-opencomputer-runtime-age-ms": "25",
        },
      },
    );
  }
  if (request.method !== "POST" || !match) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const runtimeSessionId = decodeURIComponent(match[1]);
  const route = match[2];
  const entry = state(runtimeSessionId);

  if (route === "sandbox-context") {
    if (runtimeSessionId === "runtime-prewarmed-broken") {
      return Response.json({ error: "stale_workerd_session" }, { status: 500 });
    }
    if (creationDelayMs) await sleep(creationDelayMs);
    const input = await request.json();
    if (
      typeof input.accountId !== "string" ||
      typeof input.managedSessionId !== "string" ||
      typeof input.edge !== "string" ||
      typeof input.runtimeToken !== "string" ||
      !input.deployment?.artifact?.digest
    ) {
      return Response.json({ error: "invalid_sandbox_context" }, { status: 400 });
    }
    // A prewarmed session keeps the location hint it was created with.
    entry.creation = { ...input, locationHint: entry.creation?.locationHint ?? null };
    return Response.json({ configured: true });
  }

  if (route === "terminate-computer") {
    const body = await request.json();
    entry.calls.push({ route: "terminate", reason: body.reason ?? null, at: Date.now() });
    if (entry.failTerminates > 0) {
      entry.failTerminates -= 1;
      return Response.json({ error: "injected termination failure" }, { status: 500 });
    }
    const alreadyTerminated = entry.computerTerminated;
    entry.computerTerminated = true;
    return Response.json({
      terminated: true,
      generation: entry.computerGeneration,
      sandboxId: alreadyTerminated ? null : `sb-fake-${String(entry.computerGeneration)}`,
      alreadyTerminated,
    });
  }

  if (route === "stop") {
    const body = await request.json();
    entry.calls.push({ route, turnId: body.turnId ?? null, reason: body.reason ?? null, at: Date.now() });
    if (entry.holdInterruptMs > 0) {
      const hold = entry.holdInterruptMs;
      entry.holdInterruptMs = 0;
      await sleep(hold);
    }
    if (entry.failInterrupts > 0) {
      entry.failInterrupts -= 1;
      return Response.json({ error: "injected interrupt failure" }, { status: 500 });
    }
    const live = entry.live;
    if (!live) {
      return Response.json({
        interrupted: false,
        active: false,
        turnId: null,
        generation: entry.computerGeneration,
        operations: { total: 0, settled: 0, pending: [] },
        settled: true,
      });
    }
    if (live.settleAtMs === undefined && live.holdSettlementMs !== undefined) {
      live.settleAtMs = Date.now() + live.holdSettlementMs;
    }
    const interrupted = live.stall !== undefined;
    live.stall?.("interrupted");
    live.stall = undefined;
    const operations = operationsOf(live, entry);
    const settled = operations.pending.length === 0;
    if (settled) {
      if (live.replayAfterInterrupt) {
        // Acknowledged, but the execution is still there: a loop the host
        // replayed after its own eviction. Cleared by the next stop.
        live.replayAfterInterrupt = false;
      } else {
        entry.live = undefined;
      }
    }
    return Response.json(
      {
        interrupted,
        active: false,
        turnId: live.turnId,
        generation: entry.computerGeneration,
        operations,
        settled,
      },
      { status: settled ? 200 : 409 },
    );
  }

  // route === "turn"
  const turn = await request.json();
  const text = String(turn.text ?? "");
  entry.calls.push({ route, turnId: turn.turnId ?? null, text, at: Date.now() });
  if (entry.live) {
    return Response.json(
      { error: "turn_in_progress", turnId: entry.live.turnId },
      { status: 409 },
    );
  }
  if (entry.computerTerminated) {
    // The next computer for the workspace: a new generation.
    entry.computerTerminated = false;
    entry.computerGeneration += 1;
  }
  const hold = /\[hold-interrupt (\d+)ms\]/.exec(text);
  if (hold) entry.holdInterruptMs = Number(hold[1]);
  const fail = /\[fail-interrupt (\d+)\]/.exec(text);
  if (fail) entry.failInterrupts = Number(fail[1]);
  const failTerminate = /\[fail-terminate (\d+)\]/.exec(text);
  if (failTerminate) entry.failTerminates = Number(failTerminate[1]);
  const stallMs = /\[stall (\d+)ms\]/.exec(text);
  const pauseAfterToolMs = /\[pause-after-tool (\d+)ms\]/.exec(text);
  const longProgress = /\[long-progress\]/.test(text);
  const resultCall = /\[result-call ([^\]]+)\]/.exec(text)?.[1];
  const toolBeforeStall = /\[tool-before-stall ([^\]]+)\]/.exec(text)?.[1];
  const toolFails = /\[tool-fails ([^\]]+)\]/.exec(text)?.[1];
  const modelRetry = /\[model-retry (\d+)( host)?\]/.exec(text);
  const modelFails = /\[model-fails ([^\]]+)\]/.exec(text)?.[1];
  const stepModel = /\[step-model ([^\]]+)\]/.exec(text)?.[1] ?? "anthropic/claude-sonnet-4.6";
  const delayStreamMs = /\[delay-stream (\d+)ms\]/.exec(text);
  const stepUsage = /\[step-usage\]/.test(text);
  const silent = /\[silent\]/.test(text);
  const askMatch = /\[ask(-plain)? ([^\]]+)\]/.exec(text);
  const askOwnStep = /\[ask-own-step\]/.test(text);
  const askContext = /\[ask-context ([^\]]+)\]/.exec(text)?.[1];
  const consultMatch = /\[consult ([^\s\]]+)(?: ([^\]]+))?\]/.exec(text);
  const ops = /\[ops (\d+)\]/.exec(text);
  const holdSettlement = /\[hold-settlement (\d+)ms\]/.exec(text);
  const live = {
    turnId: turn.turnId ?? null,
    stall: undefined,
    replayAfterInterrupt: /\[replay-after-interrupt\]/.test(text),
    ops: ops ? Number(ops[1]) : 0,
    holdSettlementMs: holdSettlement ? Number(holdSettlement[1]) : undefined,
    settleAtMs: undefined,
    neverSettle: /\[never-settle\]/.test(text),
  };
  entry.live = live;

  const sessionID = "opencode-managed-test";
  const rendered = frame("opencomputer.agent.rendered", {
    renderId: `render-${crypto.randomUUID()}`,
    responseId: "response-managed-test",
    providerTurn: 1,
    stateVersion: 0,
    instructionsHash: "a".repeat(64),
    instructions: "These are the deployed agent instructions.",
    enabledTools: [],
    requiredConnections: [],
    enabledMcpServers: [],
    // The typed input the managed session sent, as the real host hands it
    // to `useInput()`.
    input: turn.agentInput ?? { source: "user", text: "Tell me where this agent is running." },
    tools: [],
    model: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
    renderedAt: "2026-09-03T00:00:00.000Z",
  });
  const delta = (assistantMessageID, ordinal, value) =>
    frame("session.text.delta", { sessionID, assistantMessageID, ordinal, delta: value });
  const toolInputStarted = (id, name, assistantMessageID = "msg-1") =>
    frame("session.tool.input.started", { sessionID, assistantMessageID, id, name });
  const toolCalled = (id, input, assistantMessageID = "msg-1") =>
    frame("session.tool.called", { sessionID, assistantMessageID, id, input, executed: true });
  const toolProgress = (id, metadata) =>
    frame("session.tool.progress", { sessionID, assistantMessageID: "msg-1", id, metadata });
  const toolSuccess = (id, text) =>
    frame("session.tool.success", {
      sessionID,
      assistantMessageID: "msg-1",
      id,
      content: [{ type: "text", text }],
      executed: true,
    });
  const toolFailed = (id, message) =>
    frame("session.tool.failed", {
      sessionID,
      assistantMessageID: "msg-1",
      id,
      error: { type: "UnknownError", message },
      executed: true,
    });
  // A session with memory bindings: the host reports one observed save
  // (C7) once the turn finishes, plus a malformed frame the consumer must
  // drop. An interrupted execution never reports one.
  const saved = turn.memory
    ? frame("opencomputer.memory.saved", {
        resource: "notes",
        documentId: "workshop",
        revision: "2",
        bytes: 12,
      }) + frame("opencomputer.memory.saved", { resource: "notes" })
    : "";
  const succeeded = frame("session.execution.succeeded", { sessionID });

  const body = new ReadableStream({
    async start(controller) {
      const send = (value) => {
        try {
          controller.enqueue(encoder.encode(value));
        } catch {
          // The reader is gone; the execution goes on regardless.
        }
      };
      if (delayStreamMs) await sleep(Number(delayStreamMs[1]));
      send(rendered);
      // OpenCode names the model call's model when the step starts.
      send(
        frame("session.step.started", {
          sessionID,
          assistantMessageID: "msg-1",
          model: { id: stepModel, providerID: "openrouter" },
        }),
      );
      if (longProgress) {
        send(delta("msg-1", 0, "Progress: " + "x".repeat(22 * 1024)));
        send(frame("session.text.ended", { sessionID, assistantMessageID: "msg-1", ordinal: 0, text: "Progress: " + "x".repeat(22 * 1024) }));
        // OpenCode names the call once, then refers to it by id.
        send(toolInputStarted("call-1", "sandbox_exec"));
        send(toolCalled("call-1", { command: "npm test" }));
        send(toolSuccess("call-1", "ok"));
        if (pauseAfterToolMs) {
          await new Promise((resolve) =>
            setTimeout(resolve, Number(pauseAfterToolMs[1])),
          );
        }
        send(delta("msg-2", 0, "Final answer: "));
        send(delta("msg-2", 0, "42."));
        send(frame("session.text.ended", { sessionID, assistantMessageID: "msg-2", ordinal: 0, text: "Final answer: 42." }));
      } else if (!silent) {
        send(delta("msg-1", 0, "Managed OpenCode is "));
      }
      if (modelRetry) {
        // The stream broke after output started: OpenCode continues the
        // response in a new assistant message (a host-granted retry is
        // marked on the frame the way the Workerd runtime marks it).
        send(
          frame("session.retry.scheduled", {
            sessionID,
            assistantMessageID: "msg-1",
            attempt: Number(modelRetry[1]),
            at: Date.now() + 50,
            error: { type: "provider.transport", message: "socket hang up" },
            ...(modelRetry[2] ? { hostGranted: true } : {}),
          }),
        );
      }
      if (modelFails) {
        send(
          frame("session.execution.failed", {
            sessionID,
            error: {
              type: modelFails,
              message: "upstream socket hang up",
              ...(modelFails === "provider.internal" ? { status: 502 } : {}),
            },
          }),
        );
        if (entry.live === live) entry.live = undefined;
        try {
          controller.close();
        } catch {
          // Already cancelled by the reader.
        }
        return;
      }
      if (toolFails) {
        send(toolInputStarted(toolFails, "lookup"));
        send(toolCalled(toolFails, { q: "x" }));
        send(toolFailed(toolFails, "lookup exploded"));
      }
      if (toolBeforeStall) {
        send(toolInputStarted(toolBeforeStall, "sandbox_exec"));
        send(toolCalled(toolBeforeStall, { command: "sleep 100", timeoutSeconds: 600 }));
      }
      if (resultCall) {
        send(toolInputStarted(resultCall, "report"));
        send(toolCalled(resultCall, { branch: "task/1" }));
        send(toolProgress(resultCall, { stage: "verifying" }));
      }
      let ending = "finished";
      if (stallMs) {
        // A stop during the stall ends the stream the way OpenCode does,
        // instead of finishing the turn.
        ending = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve("finished"), Number(stallMs[1]));
          live.stall = (value) => {
            clearTimeout(timer);
            resolve(value);
          };
        });
        live.stall = undefined;
      }
      if (ending === "interrupted") {
        send(frame("session.execution.interrupted", { sessionID }));
      } else if (askMatch) {
        const callId = askMatch[2];
        const options = askMatch[1]
          ? undefined
          : [
              { label: "Go", value: "go" },
              { label: "Wait", value: "wait" },
            ];
        const askMessage = askOwnStep ? "msg-ask" : "msg-1";
        if (askOwnStep) {
          send(
            frame("session.step.ended", {
              sessionID,
              assistantMessageID: longProgress ? "msg-2" : "msg-1",
              finish: "tool-calls",
            }),
          );
          send(
            frame("session.step.started", {
              sessionID,
              assistantMessageID: askMessage,
              model: { id: stepModel, providerID: "openrouter" },
            }),
          );
        }
        send(toolInputStarted(callId, "ask", askMessage));
        const askInput = {
          text: "Which approach?",
          ...(options ? { options } : {}),
          ...(askContext ? { context: askContext } : {}),
        };
        send(toolCalled(callId, askInput, askMessage));
        send(frame("opencomputer.question.asked", { ...askInput, callId }));
        send(toolSuccess(callId, "The question is recorded and this turn ends now."));
        send(frame("session.execution.interrupted", { sessionID }));
        // Operations the turn dispatched (`[ops N]`) outlive the loop's
        // interrupt; the next /stop settles them, as the host's sweep does.
        if (entry.live === live && live.ops === 0) entry.live = undefined;
      } else if (consultMatch) {
        const callId = `consult-${consultMatch[1]}`;
        const input = { agent: consultMatch[1], prompt: consultMatch[2] ?? "What do you see?" };
        send(toolInputStarted(callId, "consult"));
        send(toolCalled(callId, input));
        send(frame("opencomputer.agent.consulted", { ...input, callId }));
        send(toolSuccess(callId, "The consultation is recorded and this turn ends now."));
        send(frame("session.execution.interrupted", { sessionID }));
        if (entry.live === live && live.ops === 0) entry.live = undefined;
      } else {
        if (resultCall) {
          send(toolSuccess(resultCall, JSON.stringify({ branch: "task/1" })));
        }
        if (!longProgress && !silent) send(delta(modelRetry ? "msg-1-continued" : "msg-1", 0, "running in the Durable Object."));
        if (stepUsage) {
          send(
            frame("session.step.ended", {
              sessionID,
              assistantMessageID: "msg-1",
              finish: "stop",
              cost: 0.0123,
              tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 5, write: 2 } },
            }),
          );
        }
        send(saved + succeeded);
        if (entry.live === live) entry.live = undefined;
      }
      try {
        controller.close();
      } catch {
        // Already cancelled by the reader.
      }
    },
    cancel() {
      // The caller went away; the execution is still live until it ends
      // on its own or is stopped.
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", ...runtimeHeaders },
  });
}
