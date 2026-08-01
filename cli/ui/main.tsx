import { useChat } from "@ai-sdk/react";
import {
  isToolUIPart,
  type ChatTransport,
  type DynamicToolUIPart,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import {
  FormEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./styles.css";

interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

interface SessionDetail extends Omit<SessionSummary, "messageCount"> {
  messages: Array<{ role: "user" | "assistant"; text: string }>;
}

interface LocalEvent {
  type: string;
  data: Record<string, unknown>;
}

const agentName =
  document.querySelector<HTMLMetaElement>('meta[name="opencomputer-agent"]')
    ?.content ?? "Agent";
const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(body.message ?? `Request failed (${response.status})`);
  }
  return response;
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

function isNearScrollEnd(element: HTMLElement, threshold = 96): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
  );
}

function toMessages(session: SessionDetail): UIMessage[] {
  return session.messages.map((message, index) => ({
    id: `${session.id}-${index}`,
    role: message.role,
    parts: [{ type: "text", text: message.text }],
  }));
}

class OpenComputerTransport implements ChatTransport<UIMessage> {
  constructor(private readonly sessionId: string) {}

  async sendMessages(
    options: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0],
  ) {
    const prompt = messageText(options.messages.at(-1)!);
    const response = await api(
      `/sessions/${encodeURIComponent(this.sessionId)}`,
      {
        method: "POST",
        body: JSON.stringify({ prompt }),
        signal: options.abortSignal,
      },
    );
    if (!response.body) throw new Error("The local session returned no stream");

    const source = response.body;
    return new ReadableStream<UIMessageChunk>({
      async start(controller) {
        const messageId = crypto.randomUUID();
        const textId = `text-${messageId}`;
        const reasoningId = `reasoning-${messageId}`;
        let textStarted = false;
        let reasoningStarted = false;
        let streamedText = "";
        const tools = new Set<string>();
        controller.enqueue({ type: "start", messageId });
        const reader = source.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            buffered += decoder.decode(result.value, { stream: true });
            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              const event = JSON.parse(line) as LocalEvent;
              if (event.type === "message.delta") {
                if (!textStarted) {
                  controller.enqueue({ type: "text-start", id: textId });
                  textStarted = true;
                }
                const delta = String(event.data.text ?? "");
                streamedText += delta;
                controller.enqueue({ type: "text-delta", id: textId, delta });
              } else if (event.type === "message.completed") {
                const complete = String(event.data.text ?? "");
                if (!textStarted) {
                  controller.enqueue({ type: "text-start", id: textId });
                  textStarted = true;
                }
                if (!streamedText && complete) {
                  controller.enqueue({
                    type: "text-delta",
                    id: textId,
                    delta: complete,
                  });
                }
              } else if (event.type === "reasoning.delta") {
                if (!reasoningStarted) {
                  controller.enqueue({
                    type: "reasoning-start",
                    id: reasoningId,
                  });
                  reasoningStarted = true;
                }
                controller.enqueue({
                  type: "reasoning-delta",
                  id: reasoningId,
                  delta: String(event.data.text ?? ""),
                });
              } else if (event.type === "tool.started") {
                const callId = String(event.data.callId ?? crypto.randomUUID());
                tools.add(callId);
                controller.enqueue({
                  type: "tool-input-available",
                  toolCallId: callId,
                  toolName: String(event.data.tool ?? "tool"),
                  title:
                    typeof event.data.title === "string"
                      ? event.data.title
                      : undefined,
                  input: event.data.input ?? {},
                  dynamic: true,
                });
              } else if (event.type === "tool.completed") {
                const callId = String(event.data.callId ?? "");
                if (tools.has(callId)) {
                  controller.enqueue({
                    type: "tool-output-available",
                    toolCallId: callId,
                    output: { status: "completed" },
                    dynamic: true,
                  });
                }
              } else if (event.type === "tool.failed") {
                const callId = String(event.data.callId ?? "");
                if (tools.has(callId)) {
                  controller.enqueue({
                    type: "tool-output-error",
                    toolCallId: callId,
                    errorText: String(event.data.message ?? "Tool failed"),
                    dynamic: true,
                  });
                }
              } else if (event.type === "session.failed") {
                throw new Error(String(event.data.message ?? "Session failed"));
              }
            }
          }
          if (reasoningStarted)
            controller.enqueue({ type: "reasoning-end", id: reasoningId });
          if (textStarted) controller.enqueue({ type: "text-end", id: textId });
          controller.enqueue({ type: "finish", finishReason: "stop" });
          controller.close();
        } catch (error) {
          controller.enqueue({
            type: "error",
            errorText: error instanceof Error ? error.message : String(error),
          });
          controller.close();
        } finally {
          reader.releaseLock();
        }
      },
      cancel: () => source.cancel(),
    });
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }
}

function ToolActivity({
  parts,
  active,
}: {
  parts: UIMessage["parts"];
  active: boolean;
}) {
  const reasoning = parts
    .filter(
      (part): part is Extract<typeof part, { type: "reasoning" }> =>
        part.type === "reasoning",
    )
    .map((part) => part.text)
    .join("");
  const tools = parts.filter(isToolUIPart) as DynamicToolUIPart[];
  const [open, setOpen] = useState(active);
  useEffect(() => setOpen(active), [active]);
  if (!reasoning && !tools.length) return null;

  return (
    <details
      className="activity"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className={active ? "pulse" : "check"}>{active ? "·" : "✓"}</span>
        {active
          ? tools.length
            ? `Working · ${tools.length} tool ${tools.length === 1 ? "call" : "calls"}`
            : "Thinking"
          : tools.length
            ? `${tools.length} tool ${tools.length === 1 ? "call" : "calls"}`
            : "Thought process"}
      </summary>
      <div className="activity-body">
        {reasoning && <p className="reasoning">{reasoning}</p>}
        {tools.map((tool) => {
          const failed =
            tool.state === "output-error" || tool.state === "output-denied";
          const done = tool.state === "output-available";
          return (
            <div
              className={`tool ${failed ? "failed" : done ? "done" : "running"}`}
              key={tool.toolCallId}
            >
              <span>{failed ? "×" : done ? "✓" : "○"}</span>
              <span>{tool.title || tool.toolName}</span>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function ChatPane({
  session,
  onFinished,
}: {
  session: SessionDetail;
  onFinished: () => void;
}) {
  const transport = useMemo(
    () => new OpenComputerTransport(session.id),
    [session.id],
  );
  const { messages, sendMessage, status, error } = useChat({
    id: session.id,
    messages: toMessages(session),
    transport,
    throttle: 24,
    onFinish: onFinished,
  });
  const [input, setInput] = useState("");
  const timeline = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const initializedScroll = useRef(false);
  const busy = status === "submitted" || status === "streaming";
  useLayoutEffect(() => {
    const element = timeline.current;
    if (!element) return;
    if (!initializedScroll.current || followOutput.current) {
      element.scrollTop = element.scrollHeight;
      followOutput.current = true;
    }
    initializedScroll.current = true;
  }, [messages, status]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const prompt = input.trim();
    if (!prompt || busy) return;
    followOutput.current = true;
    setInput("");
    void sendMessage({ text: prompt });
  };

  return (
    <main>
      <div
        className="timeline"
        ref={timeline}
        onScroll={(event) => {
          followOutput.current = isNearScrollEnd(event.currentTarget);
        }}
      >
        {!messages.length && (
          <div className="empty">
            <div className="empty-mark">✦</div>
            <h2>Start a conversation</h2>
            <p>Ask your agent to use its skills and connected tools.</p>
          </div>
        )}
        {messages.map((message, index) => {
          const isActive =
            busy &&
            index === messages.length - 1 &&
            message.role === "assistant";
          const text = messageText(message);
          return (
            <article className={`message ${message.role}`} key={message.id}>
              <div className="who">
                {message.role === "user" ? "You" : agentName}
              </div>
              {message.role === "assistant" && (
                <ToolActivity
                  parts={message.parts}
                  active={isActive && !text}
                />
              )}
              {text && (
                <div className="message-body">
                  <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
                </div>
              )}
            </article>
          );
        })}
        {error && <div className="error">{error.message}</div>}
      </div>
      <form className="composer" onSubmit={submit}>
        <div className="composer-box">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={`Message ${agentName}`}
            disabled={busy}
            rows={2}
            autoFocus
          />
          <button
            type="submit"
            disabled={!input.trim() || busy}
            aria-label="Send message"
          >
            ↑
          </button>
        </div>
        <div className="hint">Enter to send · Shift+Enter for a new line</div>
      </form>
    </main>
  );
}

function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [active, setActive] = useState<SessionDetail | null>(null);
  const [error, setError] = useState("");

  const refresh = async () => {
    const result = (await (await api("/sessions")).json()) as {
      sessions: SessionSummary[];
    };
    setSessions(result.sessions);
    return result.sessions;
  };
  const select = async (id: string) => {
    setActive(
      (await (
        await api(`/sessions/${encodeURIComponent(id)}`)
      ).json()) as SessionDetail,
    );
  };
  const create = async () => {
    const session = (await (
      await api("/sessions", { method: "POST", body: "{}" })
    ).json()) as SessionDetail;
    await refresh();
    setActive(session);
  };
  useEffect(() => {
    if (!token) {
      setError(
        "Missing dev token. Open the complete URL printed by opencomputer dev.",
      );
      return;
    }
    void refresh()
      .then((items) => (items[0] ? select(items[0].id) : create()))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, []);

  return (
    <div className="app-shell">
      <header>
        <div className="brand">
          <span className="logo">oc</span>
          <span>{agentName}</span>
          <span className="dev-badge">DEV</span>
        </div>
        <div className="status">
          <i /> Local agent
        </div>
      </header>
      <div className="workspace">
        <aside>
          <button className="new-session" onClick={() => void create()}>
            <span>＋</span> New session
          </button>
          <div className="section-label">Sessions</div>
          <nav>
            {sessions.map((session) => (
              <button
                className={active?.id === session.id ? "active" : ""}
                key={session.id}
                onClick={() => void select(session.id)}
              >
                <strong>{session.title || "New session"}</strong>
                <span>{session.messageCount} messages</span>
              </button>
            ))}
          </nav>
        </aside>
        {error ? (
          <div className="fatal">
            <strong>Could not start local app</strong>
            <p>{error}</p>
          </div>
        ) : active ? (
          <ChatPane
            key={active.id}
            session={active}
            onFinished={() => void refresh()}
          />
        ) : (
          <div className="loading">Starting local agent…</div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
