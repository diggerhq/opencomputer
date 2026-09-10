import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyEvents,
  emptyTimeline,
  failureMessage,
  inputMessageId,
  isSettledTurn,
  memorySaveFromEvent,
  type AgentEvent,
  type AgentMessage,
  type MemorySave,
  type SessionTimeline,
} from "./events.js";

export {
  applyEvent,
  applyEvents,
  emptyTimeline,
  isSettledTurn,
  type AgentEvent,
  type AgentMessage,
  type MemorySave,
  type SessionTimeline,
  type TurnStatus,
} from "./events.js";

interface CommonOptions {
  /**
   * Where the hook sends its requests; the app's own route prefix when the
   * app proxies them, the development bridge otherwise. Default
   * `/api/opencomputer/managed-agents`.
   */
  basePath?: string;
  fetch?: typeof globalThis.fetch;
  /** Every event the hook applies, in order, including replayed history. */
  onEvent?: (event: AgentEvent) => void;
  /** A save the session observed succeeding; refresh the document it names. */
  onMemorySaved?: (save: MemorySave) => void;
}

/** Create mode: the first `send` creates a session for `agent`. */
export interface CreateAgentOptions extends CommonOptions {
  /** `agent-id@alias`. */
  agent: string;
  source?: string;
  sessionId?: undefined;
}

/**
 * Attach mode: the session already exists, created by trusted code with the
 * API key. The hook replays its history, streams new turns and never
 * changes its lifecycle.
 */
export interface AttachAgentOptions extends CommonOptions {
  sessionId: string;
  agent?: undefined;
  /** Replay from this event cursor instead of the start of the log. */
  after?: number;
  /** Polling interval between empty pages in milliseconds. Default 1000; 500 while a turn runs. */
  pollIntervalMs?: number;
}

export type UseAgentOptions = CreateAgentOptions | AttachAgentOptions;

/** What `send` resolves with: the platform admitted the input as a turn. */
export interface SendReceipt {
  sessionId: string;
  turnId: string;
  /** `queued` behind earlier turns, or `running` at once. */
  status: "queued" | "running";
}

/**
 * What `send` rejects with. `code` is the platform's error code when the
 * request was answered (`session_ended`, `memory_admission_unconfirmed`,
 * `insufficient_credits`), `network_error` when it was not, `empty_input`
 * and `busy` when nothing was sent. `status` is the HTTP status when there
 * was one. The hook's `error` is set to the same message.
 */
export class SendError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = "SendError";
    this.code = code;
    this.status = status;
  }
}

export interface UseAgentResult {
  messages: AgentMessage[];
  /**
   * Starts a turn. Resolves with the admission receipt; rejects with a
   * `SendError` when no turn was admitted, so a draft can be kept. In create
   * mode the first call creates the session and the promise settles when the
   * turn ends.
   */
  send: (value: string) => Promise<SendReceipt>;
  /** Interrupts the running turn. */
  stop: () => Promise<void>;
  sessionId: string | undefined;
  /** A turn is admitted and not yet settled by the log. */
  isRunning: boolean;
  /** Attach mode: true until the existing history has been replayed. */
  isReplaying: boolean;
  error: string | undefined;
  /** `memory.saved` events in log order. */
  memorySaves: MemorySave[];
  /** The last event position applied; resume from it with `after`. */
  cursor: number;
}

const DEFAULT_BASE_PATH = "/api/opencomputer/managed-agents";

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

function upsert(
  messages: AgentMessage[],
  message: AgentMessage,
): AgentMessage[] {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index < 0) return [...messages, message];
  const next = [...messages];
  next[index] = { ...next[index], ...message };
  return next;
}

function asSendError(cause: unknown): SendError {
  if (cause instanceof SendError) return cause;
  return new SendError(
    cause instanceof Error ? cause.message : String(cause),
    "network_error",
  );
}

interface TurnAdmission {
  turnId: string;
  status: "queued" | "running";
}

export function useAgent(
  agentOrOptions: string | UseAgentOptions,
): UseAgentResult {
  const options: UseAgentOptions =
    typeof agentOrOptions === "string"
      ? { agent: agentOrOptions }
      : agentOrOptions;
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;
  const attachedSessionId = options.sessionId;
  const after = options.sessionId ? (options.after ?? 0) : 0;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [timeline, setTimeline] = useState<SessionTimeline>(emptyTimeline);
  const timelineRef = useRef(timeline);
  const [sessionId, setSessionId] = useState<string | undefined>(
    attachedSessionId,
  );
  const sessionRef = useRef<string | undefined>(attachedSessionId);
  // Bumped by every attach, so work started against an earlier attachment
  // of the same session id is fenced too.
  const attachmentRef = useRef(0);
  const cursorRef = useRef(0);
  const [isReplaying, setIsReplaying] = useState(Boolean(attachedSessionId));
  const [error, setError] = useState<string>();
  // Admission state, apart from the log: turns the platform admitted whose
  // settlement the log has not shown yet. The log's word wins as soon as it
  // arrives, and an admission the log already settled never counts.
  const [admitted, setAdmitted] = useState<string[]>([]);

  const commit = useCallback((next: SessionTimeline) => {
    timelineRef.current = next;
    setTimeline(next);
    setAdmitted((current) =>
      current.some((turnId) => isSettledTurn(next, turnId))
        ? current.filter((turnId) => !isSettledTurn(next, turnId))
        : current,
    );
  }, []);

  const request = useCallback(
    async <T>(path: string, init?: RequestInit): Promise<T> => {
      const requestFetch = optionsRef.current.fetch ?? globalThis.fetch;
      const response = await requestFetch(`${basePath}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
      });
      const body: unknown =
        response.status === 204 ? undefined : await response.json();
      if (!response.ok) {
        const problem = body as {
          error?: { code?: string; message?: string } | string;
        };
        const message =
          typeof problem?.error === "string"
            ? problem.error
            : problem?.error?.message;
        const code =
          typeof problem?.error === "object" &&
          typeof problem.error?.code === "string"
            ? problem.error.code
            : "request_failed";
        throw new SendError(
          message ?? `Agent request failed (${String(response.status)})`,
          code,
          response.status,
        );
      }
      return body as T;
    },
    [basePath],
  );

  // Applies a page of events to the timeline and runs the callbacks once per
  // event. Events the timeline already holds fire nothing. Returns how many
  // were new.
  const ingest = useCallback(
    (events: AgentEvent[]): number => {
      const fresh = events.filter(
        (event) => event.seq > timelineRef.current.cursor,
      );
      if (!fresh.length) return 0;
      commit(applyEvents(timelineRef.current, fresh));
      for (const event of fresh) {
        cursorRef.current = Math.max(cursorRef.current, event.seq);
        optionsRef.current.onEvent?.(event);
        if (event.type === "memory.saved") {
          const save = timelineRef.current.memorySaves.find(
            (candidate) => candidate.seq === event.seq,
          );
          if (save) optionsRef.current.onMemorySaved?.(save);
        }
        const failure = failureMessage(event);
        if (failure) setError(failure);
      }
      return fresh.length;
    },
    [commit],
  );

  // Attach mode: one polling loop per session, resumed from the cursor after
  // every failure, so a reconnect continues where it stopped.
  useEffect(() => {
    if (!attachedSessionId) return;
    const controller = new AbortController();
    const { signal } = controller;
    attachmentRef.current += 1;
    sessionRef.current = attachedSessionId;
    setSessionId(attachedSessionId);
    setError(undefined);
    setIsReplaying(true);
    setAdmitted([]);
    cursorRef.current = after;
    commit({ ...emptyTimeline(), cursor: after });
    void (async () => {
      let failures = 0;
      while (!signal.aborted) {
        try {
          const page = await request<{ events: AgentEvent[] }>(
            `/sessions/${encodeURIComponent(attachedSessionId)}/events?after=${String(cursorRef.current)}`,
            { signal },
          );
          if (signal.aborted) return;
          if (failures) setError(undefined);
          failures = 0;
          // A full page means more may follow: read on without waiting.
          if (ingest(page.events) > 0) continue;
          setIsReplaying(false);
        } catch (cause) {
          if (signal.aborted) return;
          failures += 1;
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        const idle =
          (optionsRef.current as AttachAgentOptions).pollIntervalMs ?? 1000;
        const base = timelineRef.current.isRunning ? Math.min(idle, 500) : idle;
        await delay(
          failures ? Math.min(base * 2 ** failures, 10_000) : base,
          signal,
        );
      }
    })();
    return () => {
      controller.abort();
    };
  }, [attachedSessionId, after, basePath, commit, ingest, request]);

  const admitTurn = useCallback(
    async (activeSession: string, prompt: string): Promise<SendReceipt> => {
      const admission = await request<TurnAdmission>(
        `/sessions/${encodeURIComponent(activeSession)}/turns`,
        {
          method: "POST",
          body: JSON.stringify({
            input: prompt,
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      return {
        sessionId: activeSession,
        turnId: admission.turnId,
        status: admission.status === "running" ? "running" : "queued",
      };
    },
    [request],
  );

  const sendAttached = useCallback(
    async (activeSession: string, prompt: string): Promise<SendReceipt> => {
      // The target is fixed here. Whatever the hook is attached to when the
      // response arrives, this response belongs to that session and that
      // attachment only; if they have changed, the caller still gets the
      // outcome and the hook's state stays with the current session.
      const attachment = attachmentRef.current;
      const current = () =>
        sessionRef.current === activeSession &&
        attachmentRef.current === attachment;
      setError(undefined);
      try {
        const receipt = await admitTurn(activeSession, prompt);
        if (current()) {
          // The log's message.received for this turn carries the same id,
          // so it confirms this message instead of duplicating it. Whether
          // the turn is still running is the log's call, not this reply's.
          const timeline = timelineRef.current;
          commit({
            ...timeline,
            messages: upsert(timeline.messages, {
              id: inputMessageId(receipt.turnId),
              role: "user",
              text: prompt,
              turnId: receipt.turnId,
            }),
          });
          if (!isSettledTurn(timelineRef.current, receipt.turnId)) {
            setAdmitted((pending) =>
              pending.includes(receipt.turnId)
                ? pending
                : [...pending, receipt.turnId],
            );
          }
        }
        return receipt;
      } catch (cause) {
        const failure = asSendError(cause);
        if (current()) setError(failure.message);
        throw failure;
      }
    },
    [admitTurn, commit],
  );

  const sendCreated = useCallback(
    async (prompt: string): Promise<SendReceipt> => {
      if (timelineRef.current.isRunning) {
        throw new SendError("A turn is already running.", "busy");
      }
      const userMessage: AgentMessage = {
        id: crypto.randomUUID(),
        role: "user",
        text: prompt,
      };
      const assistantId = crypto.randomUUID();
      const updateMessages = (
        update: (messages: AgentMessage[]) => AgentMessage[],
        patch: Partial<SessionTimeline> = {},
      ) => {
        const current = timelineRef.current;
        commit({ ...current, ...patch, messages: update(current.messages) });
      };
      updateMessages(
        (current) => [
          ...current,
          userMessage,
          { id: assistantId, role: "assistant", text: "" },
        ],
        { isRunning: true },
      );
      setError(undefined);
      let receipt: SendReceipt | undefined;
      try {
        let activeSession = sessionRef.current;
        if (!activeSession) {
          const create = optionsRef.current as CreateAgentOptions;
          const created = await request<{ session: { id: string } }>(
            "/sessions",
            {
              method: "POST",
              body: JSON.stringify({
                agentId: create.agent,
                source: create.source ?? "local-react",
              }),
            },
          );
          activeSession = created.session.id;
          sessionRef.current = activeSession;
          setSessionId(activeSession);
        } else {
          await request(
            `/sessions/${encodeURIComponent(activeSession)}/resume`,
            {
              method: "POST",
            },
          );
        }
        let streamed = "";
        const waitFor = async (terminal: (event: AgentEvent) => boolean) => {
          for (;;) {
            const result = await request<{ events: AgentEvent[] }>(
              `/sessions/${encodeURIComponent(activeSession!)}/events?after=${String(cursorRef.current)}`,
            );
            for (const event of result.events) {
              cursorRef.current = Math.max(cursorRef.current, event.seq);
              optionsRef.current.onEvent?.(event);
              if (event.type === "message.delta") {
                streamed += String(event.data.text ?? "");
                updateMessages((current) =>
                  current.map((message) =>
                    message.id === assistantId
                      ? { ...message, text: streamed }
                      : message,
                  ),
                );
              } else if (event.type === "message.completed" && !streamed) {
                const text = String(event.data.text ?? "");
                updateMessages((current) =>
                  current.map((message) =>
                    message.id === assistantId ? { ...message, text } : message,
                  ),
                );
              } else {
                const save = memorySaveFromEvent(event);
                if (save) {
                  const current = timelineRef.current;
                  commit({
                    ...current,
                    memorySaves: [...current.memorySaves, save],
                  });
                  optionsRef.current.onMemorySaved?.(save);
                }
              }
              if (terminal(event)) return event;
            }
            if (result.events.length) {
              commit({ ...timelineRef.current, cursor: cursorRef.current });
            }
            await new Promise((done) => setTimeout(done, 500));
          }
        };
        await waitFor((event) => event.type === "runtime.connected");
        receipt = await admitTurn(activeSession, prompt);
        const completed = await waitFor(
          (event) =>
            event.type === "turn.completed" ||
            event.type === "turn.failed" ||
            event.type === "turn.cancelled",
        );
        if (completed.type === "turn.failed") {
          throw new Error(String(completed.data.message ?? "Agent failed"));
        }
        await request(
          `/sessions/${encodeURIComponent(activeSession)}/suspend`,
          {
            method: "POST",
          },
        );
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        if (!receipt) {
          // Nothing was admitted: the input was never sent, so it is not
          // part of the conversation, and the caller keeps it.
          updateMessages(
            (current) =>
              current.filter(
                (item) => item.id !== userMessage.id && item.id !== assistantId,
              ),
            { isRunning: false },
          );
          throw asSendError(cause);
        }
        updateMessages((current) =>
          current.map((item) =>
            item.id === assistantId && !item.text
              ? { ...item, text: "I couldn't complete that request." }
              : item,
          ),
        );
      } finally {
        commit({
          ...timelineRef.current,
          cursor: Math.max(timelineRef.current.cursor, cursorRef.current),
          isRunning: false,
        });
      }
      if (!receipt) throw new SendError("No turn was admitted.", "busy");
      return receipt;
    },
    [admitTurn, commit, request],
  );

  const send = useCallback(
    async (value: string): Promise<SendReceipt> => {
      const prompt = value.trim();
      if (!prompt) throw new SendError("Nothing to send.", "empty_input");
      return attachedSessionId
        ? sendAttached(attachedSessionId, prompt)
        : sendCreated(prompt);
    },
    [attachedSessionId, sendAttached, sendCreated],
  );

  const stop = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!activeSession) return;
    try {
      await request(
        `/sessions/${encodeURIComponent(activeSession)}/interrupt`,
        { method: "POST" },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [request]);

  return {
    messages: timeline.messages,
    send,
    stop,
    sessionId,
    isRunning: timeline.isRunning || admitted.length > 0,
    isReplaying,
    error,
    memorySaves: timeline.memorySaves,
    cursor: timeline.cursor,
  };
}
