// Consultation state for `consult` (project sessions): one row per consult
// call, linking the question it committed to the member agent's inner
// session and turn. The question row itself is the same one `ask` commits —
// a consult is a question answered by a sibling agent instead of a person.
//
// Everything here is synchronous SQL on the Session object's storage, so
// the Session object can run it inside its own `transactionSync` together
// with the question and event writes it belongs to.

export type ConsultationStatus = "pending" | "dispatched" | "delivered" | "failed";

/**
 * What the member session reports for a consult's turn. `pending` while it
 * is queued or running; the rest are terminal and become the consult's
 * answer to the coordinator.
 */
export type ConsultTurnOutcome =
  | { kind: "pending" }
  | { kind: "completed"; finalText: string }
  | { kind: "failed"; error: string }
  | { kind: "cancelled"; reason: string | null }
  | { kind: "question"; text: string }
  /** The member never produced an answer; `detail` says why. */
  | { kind: "unavailable"; detail: string };

export interface ConsultationRow {
  [key: string]: SqlStorageValue;
  question_id: string;
  /** The member as the model named it (local name or full agent id). */
  member_ref: string;
  prompt: string;
  member_agent_id: string | null;
  member_session_id: string | null;
  member_turn_id: string | null;
  /** The idempotency key the member's turn was admitted under: `consult:{questionId}`. */
  member_turn_key: string;
  status: ConsultationStatus;
  error: string | null;
  next_attempt_at_ms: number | null;
  created_at: string;
  updated_at: string;
}

export function ensureConsultSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS agent_consultations (
      question_id TEXT PRIMARY KEY,
      member_ref TEXT NOT NULL,
      prompt TEXT NOT NULL,
      member_agent_id TEXT,
      member_session_id TEXT,
      member_turn_id TEXT,
      member_turn_key TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      next_attempt_at_ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

/** The key a consultation's turn on the member session is admitted under. */
export function consultTurnKey(questionId: string): string {
  return `consult:${questionId}`;
}

/** The key the answer's own admission on the host runs under. */
export function consultAnswerKey(questionId: string): string {
  return `consult-answer:${questionId}`;
}

export function commitConsultation(
  sql: SqlStorage,
  input: { questionId: string; memberRef: string; prompt: string },
  at: string,
): void {
  sql.exec(
    `INSERT INTO agent_consultations (
       question_id, member_ref, prompt, member_turn_key, status,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(question_id) DO NOTHING`,
    input.questionId,
    input.memberRef,
    input.prompt,
    consultTurnKey(input.questionId),
    at,
    at,
  );
}

export function consultationById(sql: SqlStorage, questionId: string): ConsultationRow | undefined {
  return sql
    .exec<ConsultationRow>("SELECT * FROM agent_consultations WHERE question_id = ?", questionId)
    .toArray()[0];
}

/** Consultations the drive owes work: undispatched, or dispatched and due for a poll. */
export function dueConsultations(sql: SqlStorage, nowMs: number, limit = 5): ConsultationRow[] {
  return sql
    .exec<ConsultationRow>(
      `SELECT * FROM agent_consultations
       WHERE status = 'pending'
          OR (status = 'dispatched' AND next_attempt_at_ms IS NOT NULL AND next_attempt_at_ms <= ?)
       ORDER BY created_at, rowid
       LIMIT ?`,
      nowMs,
      limit,
    )
    .toArray();
}

export function markConsultationDispatched(
  sql: SqlStorage,
  questionId: string,
  member: { agentId: string; sessionId: string; turnId: string | null },
  nextAttemptAtMs: number,
  at: string,
): void {
  sql.exec(
    `UPDATE agent_consultations
     SET status = 'dispatched', member_agent_id = ?, member_session_id = ?,
         member_turn_id = ?, next_attempt_at_ms = ?, updated_at = ?
     WHERE question_id = ?`,
    member.agentId,
    member.sessionId,
    member.turnId,
    nextAttemptAtMs,
    at,
    questionId,
  );
}

/** The poll of a dispatched consultation could not look yet: retry at the next alarm. */
export function deferConsultationPoll(sql: SqlStorage, questionId: string, nextAttemptAtMs: number, at: string): void {
  sql.exec(
    `UPDATE agent_consultations
     SET next_attempt_at_ms = ?, updated_at = ?
     WHERE question_id = ?`,
    nextAttemptAtMs,
    at,
    questionId,
  );
}

export function markConsultationDone(
  sql: SqlStorage,
  questionId: string,
  status: "delivered" | "failed",
  error: string | null,
  at: string,
): void {
  sql.exec(
    `UPDATE agent_consultations
     SET status = ?, error = ?, next_attempt_at_ms = NULL, updated_at = ?
     WHERE question_id = ?`,
    status,
    error,
    at,
    questionId,
  );
}

/**
 * The earliest deadline an open consultation owes, for the alarm. A pending
 * row's deadline is COALESCE'd to now — a committed consultation that never
 * reached the drive (an alarm that fired before the settle hook ran) still
 * retries on the next alarm.
 */
export function nextConsultAttemptMs(sql: SqlStorage): number | null {
  return sql
    .exec<{ due: number | null }>(
      `SELECT MIN(COALESCE(next_attempt_at_ms, 0)) AS due
       FROM agent_consultations
       WHERE status IN ('pending', 'dispatched')`,
    )
    .one().due;
}
