import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyEvents,
  emptyTimeline,
  failureMessage,
  inputMessageId,
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
  type AgentEvent,
  type AgentMessage,
  type MemorySave,
  type SessionTimeline,
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

export interface UseAgentResult {
  messages: AgentMessage[];
  /** Starts a turn. In create mode the first call creates the session. */
  send: (value: string) => Promise<void>;
  /** Interrupts the running turn. */
  stop: () => Promise<void>;
  sessionId: string | undefined;
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
  const cursorRef = useRef(0);
  const [isReplaying, setIsReplaying] = useState(Boolean(attachedSessionId));
  const [error, setError] = useState<string>();

  const commit = useCallback((next: SessionTimeline) => {
    timelineRef.current = next;
    setTimeline(next);
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
        const problem = body as { error?: { message?: string } | string };
        const message =
          typeof problem?.error === "string"
            ? problem.error
            : problem?.error?.message;
        throw new Error(
          message ?? `Agent request failed (${String(response.status)})`,
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
    sessionRef.current = attachedSessionId;
    setSessionId(attachedSessionId);
    setError(undefined);
    setIsReplaying(true);
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

  const sendAttached = useCallback(
    async (activeSession: string, prompt: string) => {
      setError(undefined);
      try {
        const result = await request<{ turnId: string }>(
          `/sessions/${encodeURIComponent(activeSession)}/turns`,
          {
            method: "POST",
            body: JSON.stringify({
              input: prompt,
              idempotencyKey: crypto.randomUUID(),
            }),
          },
        );
        // The log's message.received for this turn carries the same id, so
        // it confirms this message instead of duplicating it.
        const current = timelineRef.current;
        commit({
          ...current,
          isRunning: true,
          messages: upsert(current.messages, {
            id: inputMessageId(result.turnId),
            role: "user",
            text: prompt,
            turnId: result.turnId,
          }),
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [commit, request],
  );

  const sendCreated = useCallback(
    async (prompt: string) => {
      if (timelineRef.current.isRunning) return;
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
        await request(`/sessions/${encodeURIComponent(activeSession)}/turns`, {
          method: "POST",
          body: JSON.stringify({
            input: prompt,
            idempotencyKey: crypto.randomUUID(),
          }),
        });
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
    },
    [commit, request],
  );

  const send = useCallback(
    async (value: string) => {
      const prompt = value.trim();
      if (!prompt) return;
      if (attachedSessionId) await sendAttached(attachedSessionId, prompt);
      else await sendCreated(prompt);
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
    isRunning: timeline.isRunning,
    isReplaying,
    error,
    memorySaves: timeline.memorySaves,
    cursor: timeline.cursor,
  };
}
