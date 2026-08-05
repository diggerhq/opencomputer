/** @jsxImportSource @opentui/react */

import { createCliRenderer, SyntaxStyle } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useState } from "react";

export interface TuiEvent {
  type: string;
  data: Record<string, unknown>;
}

interface ToolState {
  id: string;
  name: string;
  title?: string;
  status: "running" | "completed" | "failed";
}

interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  reasoning: string;
  tools: ToolState[];
  active: boolean;
  error?: string;
}

interface AppProps {
  agentName: string;
  send(
    prompt: string,
    sessionId: string | undefined,
    emit: (event: TuiEvent) => void,
  ): Promise<string>;
  exit(): void;
}

const markdownStyle = SyntaxStyle.fromStyles({
  default: { fg: "#e5e5df" },
  "markup.heading": { fg: "#f1f1ea", bold: true },
  "markup.strong": { fg: "#f1f1ea", bold: true },
  "markup.italic": { fg: "#c8c8c0", italic: true },
  "markup.list": { fg: "#8fb99a" },
  "markup.raw": { fg: "#d5b87a" },
  "markup.raw.block": { fg: "#d5b87a", bg: "#1b1b19" },
  "markup.link": { fg: "#8fb99a" },
  "markup.link.label": { fg: "#8fb99a", underline: true },
  "markup.link.url": { fg: "#77776f", dim: true },
  "markup.quote": { fg: "#a8a8a0", italic: true },
});

function SessionApp({ agentName, send, exit }: AppProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [spinnerIndex, setSpinnerIndex] = useState(0);
  const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  useEffect(() => {
    if (!busy) {
      setSpinnerIndex(0);
      return;
    }
    const timer = setInterval(
      () => setSpinnerIndex((current) => (current + 1) % spinner.length),
      90,
    );
    return () => clearInterval(timer);
  }, [busy, spinner.length]);

  useKeyboard((key) => {
    if (key.ctrl && !key.shift && key.name === "c") exit();
  });

  const updateAssistant = useCallback(
    (id: string, update: (turn: Turn) => Turn) => {
      setTurns((current) =>
        current.map((turn) => (turn.id === id ? update(turn) : turn)),
      );
    },
    [],
  );

  const submit = (value: string): void => {
    const prompt = value.trim();
    if (!prompt || busy) return;
    if (prompt === "/exit" || prompt === "/quit") {
      exit();
      return;
    }
    setInput("");
    setBusy(true);
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    setTurns((current) => [
      ...current,
      {
        id: userId,
        role: "user",
        text: prompt,
        reasoning: "",
        tools: [],
        active: false,
      },
      {
        id: assistantId,
        role: "assistant",
        text: "",
        reasoning: "",
        tools: [],
        active: true,
      },
    ]);

    const emit = (event: TuiEvent): void => {
      updateAssistant(assistantId, (turn) => {
        if (event.type === "message.delta") {
          return { ...turn, text: turn.text + String(event.data.text ?? "") };
        }
        if (event.type === "message.completed") {
          return { ...turn, text: String(event.data.text ?? turn.text) };
        }
        if (event.type === "reasoning.delta") {
          return {
            ...turn,
            reasoning: turn.reasoning + String(event.data.text ?? ""),
          };
        }
        if (event.type.startsWith("tool.")) {
          const id = String(event.data.callId ?? event.data.tool ?? "tool");
          const previous = turn.tools.find((item) => item.id === id);
          const eventName =
            typeof event.data.tool === "string" ? event.data.tool.trim() : "";
          const eventTitle =
            typeof event.data.title === "string" ? event.data.title.trim() : "";
          const status =
            event.type === "tool.completed"
              ? "completed"
              : event.type === "tool.failed"
                ? "failed"
                : "running";
          const tool: ToolState = {
            id,
            name: eventName || previous?.name || "tool",
            title: eventTitle || previous?.title,
            status,
          };
          const existing = turn.tools.findIndex((item) => item.id === id);
          const tools = [...turn.tools];
          if (existing === -1) tools.push(tool);
          else tools[existing] = { ...tools[existing]!, ...tool };
          return { ...turn, tools };
        }
        return turn;
      });
    };

    void send(prompt, sessionId, emit)
      .then((nextSessionId) => setSessionId(nextSessionId))
      .catch((error: unknown) => {
        updateAssistant(assistantId, (turn) => ({
          ...turn,
          error: error instanceof Error ? error.message : String(error),
        }));
      })
      .finally(() => {
        updateAssistant(assistantId, (turn) => ({ ...turn, active: false }));
        setBusy(false);
      });
  };

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: "#11110f" }}>
      <box style={{ height: 3, paddingX: 2, flexDirection: "row", alignItems: "center", border: ["bottom"], borderColor: "#34342f" }}>
        <text fg="#f0f0e9"><strong>OpenComputer</strong></text>
        <text fg="#787870">  /  {agentName}</text>
        <box style={{ flexGrow: 1 }} />
        <text fg={busy ? "#d2aa62" : "#69aa7c"}>
          {busy ? spinner[spinnerIndex] : "●"}
        </text>
        <text fg="#85857d"> {busy ? "working" : "local"}</text>
      </box>

      <scrollbox
        style={{ flexGrow: 1, paddingX: 2, paddingY: 1 }}
        stickyScroll
        stickyStart="bottom"
      >
        {!turns.length && (
          <box style={{ flexDirection: "column", paddingTop: 2 }}>
            <ascii-font
              text="opencomputer"
              font="tiny"
              color={["#f1f1ea", "#8fb99a"]}
              selectable={false}
              style={{ marginBottom: 1 }}
            />
            <text fg="#e6e6df"><strong>Test your agent locally</strong></text>
            <text fg="#77776f">Send a message below. Connected tools are proxied through OpenComputer.</text>
          </box>
        )}
        {turns.map((turn) => (
          <box key={turn.id} style={{ flexDirection: "column", marginBottom: 1 }}>
            <text fg={turn.role === "user" ? "#999991" : "#6fa981"}>
              <strong>{turn.role === "user" ? "YOU" : agentName.toUpperCase()}</strong>
            </text>
            {turn.role === "assistant" && (turn.reasoning || turn.tools.length > 0) && (
              <box style={{ flexDirection: "column", marginTop: 1, marginBottom: turn.text ? 0 : 1 }}>
                {turn.active && !turn.text ? (
                  <>
                    {turn.reasoning && <text fg="#6f6f68">{turn.reasoning}</text>}
                    {turn.tools.map((tool) => (
                      <text key={tool.id} fg={tool.status === "failed" ? "#b66b6b" : "#77776f"}>
                        {tool.status === "completed" ? "✓" : tool.status === "failed" ? "×" : "○"} {tool.title || tool.name}
                      </text>
                    ))}
                  </>
                ) : (
                  <text fg="#66665f">✓ {turn.tools.length ? `${turn.tools.length} tool ${turn.tools.length === 1 ? "call" : "calls"}` : "thought process"}</text>
                )}
              </box>
            )}
            {turn.role === "assistant" &&
              turn.active &&
              !turn.text &&
              !turn.reasoning &&
              turn.tools.length === 0 && (
                <text fg="#77776f">{spinner[spinnerIndex]} Agent is working…</text>
              )}
            {turn.text && (
              <markdown
                content={turn.text}
                syntaxStyle={markdownStyle}
                conceal
                concealCode
                streaming={turn.active}
                internalBlockMode="top-level"
                style={{ width: "100%" }}
              />
            )}
            {turn.error && <text fg="#d27777">Error: {turn.error}</text>}
          </box>
        ))}
      </scrollbox>

      <box style={{ height: 3, marginX: 2, marginBottom: 1, paddingX: 1, flexDirection: "row", border: true, borderColor: busy ? "#3b3b36" : "#62625b", alignItems: "center" }}>
        <text fg="#77776f">› </text>
        <input
          style={{ flexGrow: 1, width: "100%" }}
          value={input}
          placeholder={busy ? "Agent is working…" : `Message ${agentName}`}
          focused={!busy}
          onInput={setInput}
          onSubmit={submit as never}
        />
      </box>
      <box style={{ height: 1, paddingX: 2 }}>
        <text fg="#575751">Enter send  ·  Drag select  ·  Ctrl+Shift+C copy  ·  Ctrl+C quit</text>
      </box>
    </box>
  );
}

export async function runSessionTUI(options: Omit<AppProps, "exit">): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);
  await new Promise<void>((done) => {
    let finished = false;
    const exit = (): void => {
      if (finished) return;
      finished = true;
      done();
    };
    root.render(<SessionApp {...options} exit={exit} />);
  });
  root.unmount();
  renderer.destroy();
}
