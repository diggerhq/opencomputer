// Question state for `ask` (design 018): one open question per session,
// answers, held steering and controls. Work 037 stream S4 owns this file.
//
// Everything here is synchronous SQL on the Session object's storage, so the
// Session object can run it inside its own `transactionSync` together with
// the turn and event writes it belongs to. Events are appended by the
// caller's `append`, which is the Session object's event log.

import { answerFor } from "../ask.js";
import type { QuestionMode } from "../channels/adapter.js";
import type {
  AgentEvent,
  AgentEventType,
  AgentInputValue,
  HeldInput,
  HeldTurnReceipt,
  QuestionAnswer,
  QuestionClosedReason,
  QuestionOption,
  SessionQuestion,
  StructuredAgentInput,
  TurnStatus,
} from "../protocol.js";
import type { SessionControlInput, SessionControlResult } from "./linear-contract.js";
import { STEERING_ITEM_LIMIT, STEERING_SIZE_LIMIT } from "../protocol.js";
import { problem } from "./http.js";
import { STRUCTURED_INPUT_LIMIT } from "./structured-input.js";

/** A turn names a question that is not the open one: `409 question_stale`. */
export const QUESTION_STALE = "question_stale";

type Append = (type: AgentEventType, data: Record<string, unknown>) => AgentEvent;

export interface QuestionRow {
  [key: string]: SqlStorageValue;
  id: string;
  turn_id: string;
  tool_call_id: string;
  text: string;
  options_json: string;
  asked_at: string;
  provider_asked_at: string | null;
  answered_at: string | null;
  answer_json: string | null;
  answered_by_turn_id: string | null;
  closed_reason: string | null;
  closed_at: string | null;
  /** The provider message that shows the question (a Slack card's `ts`), once posted. */
  channel_message_id: string | null;
  /** How it was shown: `card` (buttons) or `text` (the plain-text gate a refused card degrades to). */
  channel_message_kind: string | null;
  /** What the person needs to decide (Markdown), as the `ask` call gave it; null when it gave none. */
  context: string | null;
}

interface HeldInputRow {
  [key: string]: SqlStorageValue;
  id: string | null;
  turn_key: string;
  question_id: string;
  input_json: string;
  fingerprint: string | null;
  received_at: string;
  provider_time: string | null;
  delivered_turn_id: string | null;
  discarded_at: string | null;
  input_text: string | null;
  agent_input_json: string | null;
  subscriptions_json: string | null;
  source_turn_id: string | null;
}

interface ControlRow {
  [key: string]: SqlStorageValue;
  delivery_id: string;
  kind: string;
  provider_time: string | null;
  applied_at: string;
  result_json: string;
}

/**
 * The Session object's question tables (work 037, Storage seam). `questions`
 * adds to the seam's columns the provider's ask time (Linear's elicitation
 * `createdAt`, which decides answer versus steering), the answering turn and
 * the close time; `held_inputs` adds the key's fingerprint and its fate
 * (delivered with which turn, or discarded), so a replayed key answers with
 * a receipt instead of being admitted again.
 */
export function ensureQuestionSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      text TEXT NOT NULL,
      options_json TEXT NOT NULL DEFAULT '[]',
      asked_at TEXT NOT NULL,
      provider_asked_at TEXT,
      answered_at TEXT,
      answer_json TEXT,
      answered_by_turn_id TEXT,
      closed_reason TEXT,
      closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS held_inputs (
      turn_key TEXT PRIMARY KEY,
      question_id TEXT NOT NULL,
      input_json TEXT NOT NULL,
      fingerprint TEXT,
      received_at TEXT NOT NULL,
      provider_time TEXT,
      delivered_turn_id TEXT,
      discarded_at TEXT
    );
    CREATE TABLE IF NOT EXISTS controls (
      delivery_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      provider_time TEXT,
      applied_at TEXT NOT NULL,
      result_json TEXT NOT NULL
    );
  `);
  // A held input carries what it needs to become a turn of its own (when
  // `steering` is full, or its question is dismissed or undeliverable):
  // its public id, text, structured input and the subscriptions captured at
  // admission, and the turn it was converted from, if any.
  const columns = sql
    .exec<{ name: string }>("PRAGMA table_info(held_inputs)")
    .toArray()
    .map((column) => column.name);
  for (const [column, definition] of [
    ["id", "TEXT"],
    ["input_text", "TEXT"],
    ["agent_input_json", "TEXT"],
    ["subscriptions_json", "TEXT"],
    ["source_turn_id", "TEXT"],
  ] as const) {
    if (!columns.includes(column)) {
      sql.exec(`ALTER TABLE held_inputs ADD COLUMN ${column} ${definition}`);
    }
  }
  sql.exec(
    `UPDATE held_inputs SET id = 'held_' || lower(hex(randomblob(12))) WHERE id IS NULL`,
  );
  // A question posted to a channel as a card (slack-ux P2) remembers the
  // message, so its answer or close can rewrite it; and the context the
  // agent gave with it, shown above the question.
  const questionColumns = sql
    .exec<{ name: string }>("PRAGMA table_info(questions)")
    .toArray()
    .map((column) => column.name);
  for (const column of ["channel_message_id", "channel_message_kind", "context"] as const) {
    if (!questionColumns.includes(column)) {
      sql.exec(`ALTER TABLE questions ADD COLUMN ${column} TEXT`);
    }
  }
}

function parseOptions(encoded: string): QuestionOption[] {
  try {
    const parsed = JSON.parse(encoded) as unknown;
    return Array.isArray(parsed) ? (parsed as QuestionOption[]) : [];
  } catch {
    return [];
  }
}

export function questionOptions(row: QuestionRow): QuestionOption[] {
  return parseOptions(row.options_json);
}

/** The session's open question: asked, neither answered nor closed. */
export function openQuestion(sql: SqlStorage): QuestionRow | undefined {
  return sql
    .exec<QuestionRow>(
      `SELECT * FROM questions
       WHERE answered_at IS NULL AND closed_reason IS NULL
       ORDER BY asked_at DESC, rowid DESC LIMIT 1`,
    )
    .toArray()[0];
}

export function questionById(sql: SqlStorage, id: string): QuestionRow | undefined {
  return sql.exec<QuestionRow>("SELECT * FROM questions WHERE id = ?", id).toArray()[0];
}

/** The snapshot's `question`: the open one, or null (also on a session that never asked). */
export function snapshotQuestion(sql: SqlStorage): SessionQuestion | null {
  const open = openQuestion(sql);
  if (!open) return null;
  return {
    id: open.id,
    text: open.text,
    options: questionOptions(open),
    ...(open.context ? { context: open.context } : {}),
    askedAt: open.asked_at,
  };
}

/** The open question as a channel input that runs beside it carries it (`openQuestion`). */
export function openQuestionInput(
  question: QuestionRow,
): NonNullable<StructuredAgentInput["openQuestion"]> {
  return { id: question.id, text: question.text, options: questionOptions(question) };
}

/**
 * Inside the transaction that settles the asking turn: records the question
 * and appends `question.asked`. A question whose id is already recorded (the
 * same turn and tool call, replayed) is not asked again.
 *
 * No other question can be open here (design 018: one open question per
 * session). Under `hold`, while one is open every admission is either its
 * answer, which resolves it in the admitting transaction, or held; turns
 * queued before it existed are converted to held inputs in its own
 * settlement; and only one turn runs at a time, so a later `ask` always
 * follows an answer and is a new question. Under `flow` other turns do run
 * beside the open question, and the settlement of one that asks closes it
 * `superseded` first (`SessionDurableObject`). Should the invariant ever
 * break, the stale question is closed the only way a held question closes
 * without an answer, `stopped`, and the break is logged, so the session
 * keeps exactly one open question.
 */
export function commitQuestion(
  sql: SqlStorage,
  question: {
    id: string;
    turnId: string;
    toolCallId: string;
    text: string;
    options: QuestionOption[];
    context?: string;
    askedAt: string;
  },
  append: Append,
): { events: AgentEvent[]; committed: boolean } {
  if (questionById(sql, question.id)) return { events: [], committed: false };
  const events: AgentEvent[] = [];
  const previous = openQuestion(sql);
  if (previous) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "question_invariant_broken",
        openQuestionId: previous.id,
        questionId: question.id,
        turnId: question.turnId,
      }),
    );
    closeQuestion(sql, previous.id, "stopped", question.askedAt);
    events.push(append("question.closed", { questionId: previous.id, reason: "stopped" }));
  }
  sql.exec(
    `INSERT INTO questions (id, turn_id, tool_call_id, text, options_json, context, asked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    question.id,
    question.turnId,
    question.toolCallId,
    question.text,
    JSON.stringify(question.options),
    question.context ?? null,
    question.askedAt,
  );
  events.push(
    append("question.asked", {
      questionId: question.id,
      text: question.text,
      options: question.options,
      ...(question.context ? { context: question.context } : {}),
    }),
  );
  return { events, committed: true };
}

function closeQuestion(
  sql: SqlStorage,
  id: string,
  reason: QuestionClosedReason,
  at: string,
): void {
  sql.exec(
    `UPDATE questions SET closed_reason = ?, closed_at = ?
     WHERE id = ? AND answered_at IS NULL AND closed_reason IS NULL`,
    reason,
    at,
    id,
  );
}

/**
 * Closes the open question without an answer and appends `question.closed`.
 * With `questionId`, only that question, and only while it is the open one.
 */
export function closeOpenQuestion(
  sql: SqlStorage,
  reason: QuestionClosedReason,
  at: string,
  append: Append,
  questionId?: string,
): { questionId?: string; events: AgentEvent[] } {
  const open = openQuestion(sql);
  if (!open || (questionId !== undefined && open.id !== questionId)) return { events: [] };
  closeQuestion(sql, open.id, reason, at);
  return {
    questionId: open.id,
    events: [append("question.closed", { questionId: open.id, reason })],
  };
}

/**
 * Records when the provider says the question's elicitation was created
 * (Linear's activity `createdAt`), which decides answer versus steering for
 * provider inputs from then on. The first recorded time stands: a
 * reconciled duplicate post does not move it. True when this call recorded
 * it on a question that is still open, so the caller reclassifies what is
 * held under it (`heldAnswerCandidate`).
 */
export function recordQuestionProviderTime(
  sql: SqlStorage,
  questionId: string,
  providerAskedAt: string,
): boolean {
  if (!Number.isFinite(Date.parse(providerAskedAt))) return false;
  const written = sql.exec(
    `UPDATE questions SET provider_asked_at = ?
     WHERE id = ? AND provider_asked_at IS NULL`,
    providerAskedAt,
    questionId,
  ).rowsWritten;
  return written > 0 && openQuestion(sql)?.id === questionId;
}

/**
 * Records the channel message that shows the question (a Slack card's
 * `ts`). The first recorded message stands: a retried post that Slack
 * accepted twice does not move it.
 */
export function recordQuestionChannelMessage(
  sql: SqlStorage,
  questionId: string,
  messageId: string,
  kind: "card" | "text",
): void {
  sql.exec(
    `UPDATE questions SET channel_message_id = ?, channel_message_kind = ?
     WHERE id = ? AND channel_message_id IS NULL`,
    messageId,
    kind,
    questionId,
  );
}

/**
 * The channel refused the question's card for good: from now on it is
 * posted as a plain-text gate (options listed; a typed reply runs as a
 * turn that carries the question).
 */
export function markQuestionTextGate(sql: SqlStorage, questionId: string): void {
  sql.exec(
    `UPDATE questions SET channel_message_kind = 'text'
     WHERE id = ? AND channel_message_id IS NULL`,
    questionId,
  );
}

/** What an input is to the question state when it arrives. */
export type QuestionAdmission =
  /** No question is open and the input names none: an ordinary turn. */
  | { kind: "none" }
  /** The input names a question that is not the open one. */
  | { kind: "stale"; questionId: string }
  /** The input answers the open question. */
  | { kind: "answer"; question: QuestionRow }
  /** A question is open and the input does not answer it: held as steering. */
  | { kind: "hold"; question: QuestionRow }
  /**
   * A question is open on a channel that does not hold (`flow`) and the
   * input does not name it: an ordinary turn, with the question left open.
   */
  | { kind: "flow"; question: QuestionRow };

/** The time a provider input is compared with: Linear's time for the elicitation, or `asked_at` until it is known. */
function questionTime(question: QuestionRow): number {
  return Date.parse(question.provider_asked_at ?? question.asked_at);
}

function writtenAfter(providerTime: string | null | undefined, question: QuestionRow): boolean {
  if (!providerTime) return false;
  const provided = Date.parse(providerTime);
  const asked = questionTime(question);
  return Number.isFinite(provided) && Number.isFinite(asked) && provided > asked;
}

/**
 * Answer versus steering. `answers` must name the open question. Without
 * it, the open question's mode decides (`modeOf`; `hold` when not given).
 * Under `flow` the input is an ordinary turn and the question stays open:
 * its provider time is not compared. Under `hold` an input with a provider
 * time answers the open question when that time is later than the
 * provider's own time for the question's elicitation (never by arrival
 * order). Until that time is known, the question's `asked_at` stands in for
 * it; when it becomes known, what is still held is classified again
 * (`heldAnswerCandidate`). Everything else waits as steering.
 */
export function classifyAdmission(
  sql: SqlStorage,
  input: { answers?: string; providerTime?: string },
  modeOf: (question: QuestionRow) => QuestionMode = () => "hold",
): QuestionAdmission {
  const open = openQuestion(sql);
  if (input.answers !== undefined) {
    if (!open || open.id !== input.answers) {
      return { kind: "stale", questionId: input.answers };
    }
    return { kind: "answer", question: open };
  }
  if (!open) return { kind: "none" };
  if (modeOf(open) === "flow") return { kind: "flow", question: open };
  if (writtenAfter(input.providerTime, open)) return { kind: "answer", question: open };
  return { kind: "hold", question: open };
}

/** An input as the answering turn receives it in `steering`. */
export function heldInputOf(
  agentInput: StructuredAgentInput,
  inputText: string,
  receivedAt: string,
  providerTime?: string,
): HeldInput {
  return {
    text: agentInput.text ?? inputText,
    ...(agentInput.payload !== undefined ? { payload: agentInput.payload } : {}),
    ...(agentInput.channel ? { channel: agentInput.channel } : {}),
    receivedAt,
    ...(providerTime ? { providerTime } : {}),
  };
}

/**
 * The receipt for a key that was held. Held or discarded inputs answer with
 * a held receipt; one already delivered answers with the receipt of the turn
 * that carried it (as steering, as the answer, or as a turn of its own). The
 * same key with other content is the caller's to refuse (`conflict`).
 */
export function heldReceipt(
  sql: SqlStorage,
  key: string,
  fingerprint: string,
):
  | { kind: "held"; receipt: HeldTurnReceipt }
  | { kind: "delivered"; turnId: string; status: TurnStatus }
  | { kind: "conflict" }
  | undefined {
  const row = sql
    .exec<HeldInputRow>("SELECT * FROM held_inputs WHERE turn_key = ?", key)
    .toArray()[0];
  if (!row) return undefined;
  if (row.fingerprint !== null && row.fingerprint !== fingerprint) return { kind: "conflict" };
  if (row.delivered_turn_id) {
    const turn = sql
      .exec<{ status: string }>("SELECT status FROM turns WHERE id = ?", row.delivered_turn_id)
      .toArray()[0];
    if (turn) {
      return { kind: "delivered", turnId: row.delivered_turn_id, status: turn.status as TurnStatus };
    }
  }
  return {
    kind: "held",
    receipt: {
      status: row.discarded_at ? "discarded" : "held",
      questionId: row.question_id,
      heldId: row.id ?? row.turn_key,
      duplicate: true,
    },
  };
}

/** A held input not yet delivered or discarded, with what it needs to become a turn. */
export interface PendingHeld {
  id: string;
  key: string;
  questionId: string;
  input: HeldInput;
  /** Its encoded size in `steering`. */
  size: number;
  /** The turn's text and structured input, as admitted. */
  inputText: string;
  agentInput: StructuredAgentInput;
  /** Outcome subscriptions captured at its admission. */
  subscriptionsJson: string;
  providerTime: string | null;
  /** The queued turn it was converted from, if it was one. */
  sourceTurnId: string | null;
}

function pendingHeldOf(row: HeldInputRow): PendingHeld | undefined {
  let input: HeldInput;
  try {
    input = JSON.parse(row.input_json) as HeldInput;
  } catch {
    return undefined;
  }
  let agentInput: StructuredAgentInput | undefined;
  if (row.agent_input_json) {
    try {
      const parsed = JSON.parse(row.agent_input_json) as unknown;
      if (isRecord(parsed)) agentInput = parsed as unknown as StructuredAgentInput;
    } catch {
      agentInput = undefined;
    }
  }
  const text = row.input_text ?? input.text ?? "";
  return {
    id: row.id ?? row.turn_key,
    key: row.turn_key,
    questionId: row.question_id,
    input,
    size: row.input_json.length,
    inputText: text,
    agentInput: agentInput ?? {
      source: input.channel ? "channel" : "user",
      text,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
    },
    subscriptionsJson: row.subscriptions_json ?? "[]",
    providerTime: row.provider_time,
    sourceTurnId: row.source_turn_id,
  };
}

/** Held inputs of a question not yet delivered or discarded, in arrival order. */
export function pendingHeld(sql: SqlStorage, questionId: string): PendingHeld[] {
  return sql
    .exec<HeldInputRow>(
      `SELECT * FROM held_inputs
       WHERE question_id = ? AND delivered_turn_id IS NULL AND discarded_at IS NULL
       ORDER BY received_at, rowid`,
      questionId,
    )
    .toArray()
    .flatMap((row) => {
      const pending = pendingHeldOf(row);
      return pending ? [pending] : [];
    });
}

/** The `message.held` event's data for a held input. */
export function heldEventData(held: PendingHeld): Record<string, unknown> {
  return {
    heldId: held.id,
    questionId: held.questionId,
    input: held.inputText,
    ...(held.input.payload !== undefined ? { payload: held.input.payload } : {}),
    receivedAt: held.input.receivedAt,
    ...(held.providerTime ? { providerTime: held.providerTime } : {}),
    ...(held.sourceTurnId ? { turnId: held.sourceTurnId } : {}),
  };
}

/**
 * Holds one input behind the open question; returns it as stored, or
 * undefined when its key is already held. Each held input is bounded like
 * any turn input; there is no bound on how many are held together, since
 * `steering` takes only what fits and the rest runs as ordinary turns.
 */
export function holdInput(
  sql: SqlStorage,
  held: {
    key: string;
    questionId: string;
    input: HeldInput;
    fingerprint: string | null;
    inputText: string;
    agentInput: StructuredAgentInput;
    subscriptionsJson: string;
    sourceTurnId?: string;
  },
): PendingHeld | undefined {
  const encoded = JSON.stringify(held.input);
  const encodedAgentInput = JSON.stringify(held.agentInput);
  if (encoded.length > STRUCTURED_INPUT_LIMIT || encodedAgentInput.length > STRUCTURED_INPUT_LIMIT) {
    throw new Error("Structured turn input cannot exceed 256 KiB");
  }
  const id = `held_${crypto.randomUUID().replace(/-/g, "")}`;
  const written = sql.exec(
    `INSERT INTO held_inputs (
       id, turn_key, question_id, input_json, fingerprint, received_at, provider_time,
       input_text, agent_input_json, subscriptions_json, source_turn_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(turn_key) DO NOTHING`,
    id,
    held.key,
    held.questionId,
    encoded,
    held.fingerprint,
    held.input.receivedAt,
    held.input.providerTime ?? null,
    held.inputText,
    encodedAgentInput,
    held.subscriptionsJson,
    held.sourceTurnId ?? null,
  ).rowsWritten;
  if (written === 0) return undefined;
  return pendingHeldOf(
    sql.exec<HeldInputRow>("SELECT * FROM held_inputs WHERE turn_key = ?", held.key).one(),
  );
}

/**
 * Splits held inputs, in order, into what the answering turn carries as
 * `steering` (at most `STEERING_ITEM_LIMIT` items and `STEERING_SIZE_LIMIT`
 * encoded) and what runs as ordinary turns after it. The split is a prefix:
 * once one input does not fit, it and everything after it run as turns, so
 * the agent sees them in the order they were written.
 */
export function splitSteering(held: PendingHeld[]): { steering: PendingHeld[]; overflow: PendingHeld[] } {
  let size = 0;
  let index = 0;
  for (; index < held.length && index < STEERING_ITEM_LIMIT; index++) {
    // Each entry costs its encoding and a separator in the array.
    const next = size + held[index]!.size + 1;
    if (next > STEERING_SIZE_LIMIT) break;
    size = next;
  }
  return { steering: held.slice(0, index), overflow: held.slice(index) };
}

/**
 * After the elicitation's provider time is recorded: the held input that
 * answers the open question, if one was written after it (the earliest by
 * provider time, then arrival), and the other held inputs written after it,
 * which would have arrived with no question open and run as ordinary turns.
 */
export function heldAnswerCandidate(
  sql: SqlStorage,
  question: QuestionRow,
): { answer: PendingHeld; later: PendingHeld[] } | undefined {
  const after = pendingHeld(sql, question.id).filter((held) => writtenAfter(held.providerTime, question));
  if (after.length === 0) return undefined;
  const [answer, ...later] = [...after].sort(
    (a, b) => Date.parse(a.providerTime!) - Date.parse(b.providerTime!),
  );
  return { answer: answer!, later: later.sort((a, b) => after.indexOf(a) - after.indexOf(b)) };
}

/** Marks a held input delivered with `turnId` (as steering, as the answer, or as its own turn). */
export function markHeldDelivered(sql: SqlStorage, heldId: string, turnId: string): void {
  sql.exec(
    `UPDATE held_inputs SET delivered_turn_id = ?
     WHERE id = ? AND delivered_turn_id IS NULL AND discarded_at IS NULL`,
    turnId,
    heldId,
  );
}

/**
 * Inside the transaction that admits the answering turn: resolves the
 * question and returns how its text answers it. The caller delivers the held
 * inputs (`pendingHeld`, `splitSteering`) and appends `question.answered`
 * after the turn's own `message.received`.
 */
export function answerQuestion(
  sql: SqlStorage,
  question: QuestionRow,
  text: string,
  turnId: string,
  at: string,
): QuestionAnswer {
  const answer = answerFor({ id: question.id, options: questionOptions(question) }, text);
  sql.exec(
    `UPDATE questions SET answered_at = ?, answer_json = ?, answered_by_turn_id = ?
     WHERE id = ?`,
    at,
    JSON.stringify(answer),
    turnId,
    question.id,
  );
  return answer;
}

/** Discards every pending held input (stop, end); returns them in arrival order. */
export function discardHeldInputs(sql: SqlStorage, at: string): PendingHeld[] {
  const rows = sql
    .exec<HeldInputRow>(
      `SELECT * FROM held_inputs
       WHERE delivered_turn_id IS NULL AND discarded_at IS NULL
       ORDER BY received_at, rowid`,
    )
    .toArray()
    .flatMap((row) => {
      const pending = pendingHeldOf(row);
      return pending ? [pending] : [];
    });
  sql.exec(
    `UPDATE held_inputs SET discarded_at = ?
     WHERE delivered_turn_id IS NULL AND discarded_at IS NULL`,
    at,
  );
  return rows;
}

/** The recorded result of a control already applied, as a repeat answers it. */
export function recordedControl(
  sql: SqlStorage,
  deliveryId: string,
): SessionControlResult | undefined {
  const row = sql
    .exec<ControlRow>("SELECT * FROM controls WHERE delivery_id = ?", deliveryId)
    .toArray()[0];
  if (!row) return undefined;
  return { ...(JSON.parse(row.result_json) as SessionControlResult), duplicate: true };
}

export function recordControl(
  sql: SqlStorage,
  input: SessionControlInput,
  result: SessionControlResult,
): void {
  sql.exec(
    `INSERT INTO controls (delivery_id, kind, provider_time, applied_at, result_json)
     VALUES (?, ?, ?, ?, ?)`,
    input.deliveryId,
    input.kind,
    input.providerTime,
    result.appliedAt,
    JSON.stringify({ ...result, duplicate: false }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseChannel(value: unknown): HeldInput["channel"] | undefined {
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.connectionId !== "string") {
    return undefined;
  }
  return {
    provider: value.provider,
    connectionId: value.connectionId,
    ...(typeof value.workspaceId === "string" ? { workspaceId: value.workspaceId } : {}),
    ...(typeof value.conversationId === "string" ? { conversationId: value.conversationId } : {}),
    ...(typeof value.userId === "string" ? { userId: value.userId } : {}),
  };
}

/**
 * `answer` and `steering` of a stored structured input, validated, for the
 * Session object's input reader (which rebuilds every input from named
 * pieces and drops anything it does not name).
 */
export function questionInputFields(
  parsed: Record<string, unknown>,
): Pick<StructuredAgentInput, "answer" | "steering"> {
  const answer = isRecord(parsed.answer) ? parsed.answer : null;
  const validAnswer =
    answer && typeof answer.questionId === "string" && typeof answer.text === "string";
  const steering = Array.isArray(parsed.steering)
    ? parsed.steering.flatMap((entry): HeldInput[] => {
        if (!isRecord(entry) || typeof entry.receivedAt !== "string") return [];
        const channel = parseChannel(entry.channel);
        return [
          {
            ...(typeof entry.text === "string" ? { text: entry.text } : {}),
            ...(entry.payload !== undefined ? { payload: entry.payload as AgentInputValue } : {}),
            ...(channel ? { channel } : {}),
            receivedAt: entry.receivedAt,
            ...(typeof entry.providerTime === "string" ? { providerTime: entry.providerTime } : {}),
          },
        ];
      })
    : [];
  return {
    ...(validAnswer
      ? {
          answer: {
            questionId: answer.questionId as string,
            text: answer.text as string,
            ...(typeof answer.value === "string" ? { value: answer.value } : {}),
          },
        }
      : {}),
    ...(steering.length ? { steering } : {}),
  };
}

/** `outcome` and `question` of a stored outcome event, validated, for the same reader. */
export function outcomeEventQuestionFields(
  event: Record<string, unknown>,
): {
  outcome?: "question";
  question?: { id: string; text: string; options: QuestionOption[]; context?: string };
} {
  if (event.outcome !== "question") return {};
  const question = isRecord(event.question) ? event.question : null;
  const options = Array.isArray(question?.options)
    ? question.options.flatMap((option): QuestionOption[] =>
        isRecord(option) && typeof option.label === "string" && typeof option.value === "string"
          ? [{ label: option.label, value: option.value }]
          : [],
      )
    : [];
  return {
    outcome: "question",
    ...(question && typeof question.id === "string" && typeof question.text === "string"
      ? {
          question: {
            id: question.id,
            text: question.text,
            options,
            ...(typeof question.context === "string" && question.context
              ? { context: question.context }
              : {}),
          },
        }
      : {}),
  };
}

// ── Public turn route (index.ts hook) ─────────────────────────────────────────

/** `answers` on `POST /sessions/{id}/turns`: undefined when absent, null when malformed. */
export function parseTurnAnswers(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 256) return null;
  return value;
}

/** The public answer to a question-state refusal from turn admission, if it is one. */
export function questionAdmissionProblem(error: unknown): Response | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.message.startsWith(QUESTION_STALE)) {
    return problem(
      409,
      QUESTION_STALE,
      "answers names a question that is not the session's open question",
    );
  }
  return undefined;
}
