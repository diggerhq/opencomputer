import type { AgentEvent } from "../protocol.js";

export interface SlackStatus {
  status: string;
  loadingMessages?: string[];
}

export interface SlackTaskUpdate {
  type: "task_update";
  id: string;
  title: string;
  status: "in_progress" | "complete" | "error";
}

/**
 * Where task cards go: Slack's `chat.*Stream` methods behind the same
 * lazily-opened stream message. `append` may batch several updates in one
 * call; `stop` finalizes the stream.
 */
export interface SlackProgressStream {
  append(chunks: SlackTaskUpdate[]): Promise<void>;
  stop(): Promise<void>;
}

type SlackStatusUpdater = (status: SlackStatus) => Promise<void>;

const STATUS_MAX_LENGTH = 50;
const TASK_TITLE_MAX_LENGTH = 240;
const REASONING_REFRESH_INTERVAL_MS = 5_000;
const REASONING_MIN_PROGRESS_CHARS = 4;
const SALIENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  bash: ["command"],
  glob: ["pattern"],
  grep: ["pattern", "path"],
  read: ["filePath", "path"],
  read_file: ["filePath"],
  webfetch: ["url"],
  websearch: ["query"],
  write: ["filePath", "path"],
  write_file: ["filePath"],
};
const GENERIC_KEYS = [
  "filePath",
  "path",
  "pattern",
  "command",
  "query",
  "name",
  "url",
] as const;

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

export function truncateSlackStatus(value: string): string {
  const normalized = value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(normalized, STATUS_MAX_LENGTH);
}

function compactArgument(value: string): string {
  const firstLine = value.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length <= 40) return firstLine;
  if (firstLine.includes("/") && !firstLine.includes(" ")) {
    const tail = firstLine.split("/").filter(Boolean).slice(-2).join("/");
    if (tail.length <= 40) return tail;
  }
  return truncate(firstLine, 40);
}

export function describeSlackTool(event: AgentEvent): string {
  const tool =
    typeof event.data.tool === "string" ? event.data.tool : "tool";
  if (tool === "consult") {
    const agent =
      event.data.input &&
      typeof event.data.input === "object" &&
      !Array.isArray(event.data.input) &&
      typeof (event.data.input as Record<string, unknown>).agent === "string"
        ? String((event.data.input as Record<string, unknown>).agent)
        : "";
    return truncateSlackStatus(
      agent ? `Consulting ${agent}...` : "Consulting...",
    );
  }
  const input =
    event.data.input &&
    typeof event.data.input === "object" &&
    !Array.isArray(event.data.input)
      ? (event.data.input as Record<string, unknown>)
      : {};
  for (const key of SALIENT_KEYS[tool] ?? GENERIC_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return truncateSlackStatus(`${tool} ${compactArgument(value)}`);
    }
    if (typeof value === "number") {
      return truncateSlackStatus(`${tool} ${String(value)}`);
    }
  }
  const title =
    typeof event.data.title === "string" ? event.data.title.trim() : "";
  return truncateSlackStatus(title || tool);
}

/**
 * The status line under a person's message while their turn runs, plus the
 * thinking-steps stream that folds into a collapsed card when it settles.
 *
 * One request is in flight at a time. Status text is latest-wins — a line the
 * person never got to see is not worth a round trip — while task chunks are
 * cumulative and coalesce behind whatever is already flying. `stop()` drains
 * the chunks before finalizing the stream, because delivery waits for the
 * line to be cleared before the answer posts.
 */
export class SlackProgress {
  private inFlight: Promise<void> | undefined;
  private pending: SlackStatus | undefined;
  private pendingChunks: SlackTaskUpdate[] = [
    {
      type: "task_update",
      id: "step-1",
      title: "Reading your request...",
      status: "complete",
    },
    {
      type: "task_update",
      id: "step-2",
      title: "Inspecting the workspace...",
      status: "complete",
    },
    {
      type: "task_update",
      id: "step-3",
      title: "Planning the next step...",
      status: "in_progress",
    },
  ];
  private lastReasoningAt = 0;
  private lastReasoningStatus = "";
  private lastReasoningTaskId: string | undefined;
  private reasoning = "";
  // The three opening lines a turn always spends its first seconds on. They
  // ride out with the first real append, so a turn that produces no steps
  // never opens an empty stream — but a busy plan already has shape by the
  // time the runtime answers.
  private taskSeq = 3;
  private openTask: { id: string; title: string } | undefined = {
    id: "step-3",
    title: "Planning the next step...",
  };
  private stopped = false;
  private writing = false;
  private streamFailed = false;

  constructor(
    private readonly update: SlackStatusUpdater,
    private readonly stream?: SlackProgressStream,
  ) {}

  start(): void {
    this.enqueue({ status: "Thinking..." }, true);
  }

  runtimeStarting(): void {
    // Internal bootstrapping stays on the status line only — it is not a
    // step the person asked for, so it gets no card in the plan.
    this.enqueue({ status: "Starting OpenCode..." }, true);
  }

  runtimeReady(): void {
    this.enqueue({ status: "Working..." }, true);
  }

  handle(event: AgentEvent): void {
    if (event.type === "reasoning.delta") {
      this.reasoning += String(event.data.text ?? "");
      const line = this.reasoning
        .split(/\r?\n/)
        .map((candidate) => candidate.trim())
        .find(Boolean);
      if (!line) return;
      const status = truncateSlackStatus(line);
      const now = Date.now();
      const progressive =
        this.lastReasoningStatus.length > 0 &&
        status.startsWith(this.lastReasoningStatus) &&
        status.length >=
          this.lastReasoningStatus.length + REASONING_MIN_PROGRESS_CHARS;
      if (
        !progressive &&
        now - this.lastReasoningAt < REASONING_REFRESH_INTERVAL_MS
      ) {
        return;
      }
      this.lastReasoningAt = now;
      // A growing reasoning line edits its task card in place; a new line
      // earns a card of its own.
      if (
        this.lastReasoningTaskId &&
        this.openTask?.id === this.lastReasoningTaskId &&
        status.startsWith(this.lastReasoningStatus)
      ) {
        this.renameOpenTask(status);
      } else {
        this.task(status);
        this.lastReasoningTaskId = this.openTask?.id;
      }
      this.lastReasoningStatus = status;
      this.enqueue({ status });
      return;
    }
    if (event.type === "tool.started") {
      const status = describeSlackTool(event);
      this.task(status);
      this.enqueue({ status }, true);
      return;
    }
    if (event.type === "tool.failed") {
      this.completeOpenTask("error");
      this.enqueue({ status: "Recovering from a tool error..." }, true);
      return;
    }
    if (event.type === "message.delta" && !this.writing) {
      this.writing = true;
      this.task("Writing response...");
      this.enqueue({ status: "Writing response..." }, true);
    }
  }

  async stop(options: { clear?: boolean } = {}): Promise<void> {
    this.stopped = true;
    this.pending = undefined;
    await this.inFlight;
    this.completeOpenTask();
    // The stream cannot take chunks after stopStream, so every queued task
    // update goes out first.
    while (this.stream && this.pendingChunks.length && !this.streamFailed) {
      await this.pump();
    }
    await this.inFlight;
    // Finalize even when an append failed: the stream may still be open
    // server-side, and an un-stopped one stays spinning forever.
    if (this.stream) {
      await this.stream.stop().catch(() => undefined);
    }
    if (options.clear) {
      await this.update({ status: "" });
    }
  }

  /** A new task card: the open one completes, the new one starts in flight. */
  private task(title: string): void {
    if (this.stopped) return;
    title = truncate(title, TASK_TITLE_MAX_LENGTH);
    if (!title || this.openTask?.title === title) return;
    const chunks: SlackTaskUpdate[] = [];
    if (this.openTask) {
      chunks.push({
        type: "task_update",
        id: this.openTask.id,
        title: this.openTask.title,
        status: "complete",
      });
    }
    const id = `step-${++this.taskSeq}`;
    this.openTask = { id, title };
    chunks.push({ type: "task_update", id, title, status: "in_progress" });
    this.enqueueChunks(chunks);
  }

  /** The open card's title grows in place — a reasoning line still forming. */
  private renameOpenTask(title: string): void {
    if (this.stopped || !this.openTask) return;
    title = truncate(title, TASK_TITLE_MAX_LENGTH);
    this.openTask.title = title;
    this.enqueueChunks([
      {
        type: "task_update",
        id: this.openTask.id,
        title,
        status: "in_progress",
      },
    ]);
  }

  private completeOpenTask(
    status: "complete" | "error" = "complete",
  ): void {
    const task = this.openTask;
    this.openTask = undefined;
    if (task) {
      this.enqueueChunks([
        { type: "task_update", id: task.id, title: task.title, status },
      ]);
    }
  }

  private enqueue(status: SlackStatus, force = false): void {
    if (this.stopped) return;
    if (!force && !status.status) return;
    this.pending = status;
    void this.pump();
  }

  // Chunks are not gated on `stopped`: stop() itself queues the last card's
  // completion before finalizing the stream.
  private enqueueChunks(chunks: SlackTaskUpdate[]): void {
    if (!this.stream || this.streamFailed) return;
    this.pendingChunks.push(...chunks);
    void this.pump();
  }

  /** Sends the next unit of work: queued task chunks, then the latest status. */
  private pump(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.pendingChunks.length && this.stream && !this.streamFailed) {
      const chunks = this.pendingChunks;
      this.pendingChunks = [];
      this.inFlight = this.stream
        .append(chunks)
        .catch(() => {
          // A stream that cannot start or append degrades to the shimmer —
          // nothing else the person sees depends on it.
          this.streamFailed = true;
          this.pendingChunks = [];
        })
        .then(() => {
          this.inFlight = undefined;
          void this.pump();
        });
      return this.inFlight;
    }
    if (this.pending) {
      const status = this.pending;
      this.pending = undefined;
      this.inFlight = this.update(status)
        .catch(() => undefined)
        .then(() => {
          this.inFlight = undefined;
          void this.pump();
        });
      return this.inFlight;
    }
    return Promise.resolve();
  }
}
