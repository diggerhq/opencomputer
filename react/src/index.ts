import { useCallback, useRef, useState } from "react";

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface UseAgentOptions {
  agent: string;
  source?: string;
  basePath?: string;
  fetch?: typeof globalThis.fetch;
}

interface AgentEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

export function useAgent(agentOrOptions: string | UseAgentOptions) {
  const options =
    typeof agentOrOptions === "string"
      ? { agent: agentOrOptions }
      : agentOrOptions;
  const basePath = options.basePath ?? "/api/opencomputer/managed-agents";
  const requestFetch = options.fetch ?? globalThis.fetch;
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const sessionRef = useRef<string | undefined>(undefined);
  const cursorRef = useRef(0);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string>();

  const request = useCallback(
    async <T>(path: string, init?: RequestInit): Promise<T> => {
      const response = await requestFetch(`${basePath}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const problem = body as { error?: { message?: string } };
        throw new Error(
          problem?.error?.message ??
            `Agent request failed (${String(response.status)})`,
        );
      }
      return body as T;
    },
    [basePath, requestFetch],
  );

  const send = useCallback(
    async (value: string) => {
      const prompt = value.trim();
      if (!prompt || isRunning) return;
      const userMessage: AgentMessage = {
        id: crypto.randomUUID(),
        role: "user",
        text: prompt,
      };
      const assistantId = crypto.randomUUID();
      setMessages((current) => [
        ...current,
        userMessage,
        { id: assistantId, role: "assistant", text: "" },
      ]);
      setIsRunning(true);
      setError(undefined);
      try {
        let activeSession = sessionRef.current;
        if (!activeSession) {
          const created = await request<{ session: { id: string } }>(
            "/sessions",
            {
              method: "POST",
              body: JSON.stringify({
                agentId: options.agent,
                source: options.source ?? "local-react",
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
              if (event.type === "message.delta") {
                streamed += String(event.data.text ?? "");
                setMessages((current) =>
                  current.map((message) =>
                    message.id === assistantId
                      ? { ...message, text: streamed }
                      : message,
                  ),
                );
              } else if (event.type === "message.completed" && !streamed) {
                const text = String(event.data.text ?? "");
                setMessages((current) =>
                  current.map((message) =>
                    message.id === assistantId ? { ...message, text } : message,
                  ),
                );
              }
              if (terminal(event)) return event;
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
            event.type === "turn.completed" || event.type === "turn.failed",
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
        setMessages((current) =>
          current.map((item) =>
            item.id === assistantId && !item.text
              ? { ...item, text: "I couldn't complete that request." }
              : item,
          ),
        );
      } finally {
        setIsRunning(false);
      }
    },
    [isRunning, options.agent, options.source, request],
  );

  return { messages, send, sessionId, isRunning, error };
}
