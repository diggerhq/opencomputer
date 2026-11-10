// The Computer API's operations (work 084; opc/docs/api/websocket/methods.mdx
// and http/*.mdx): params and result of every WebSocket method, which are also
// its HTTP route's body/query and response, and the WebSocket notifications.
//
// Invariants: params are decoded strictly (unknown fields are refused with
// -32602 / 400 invalid_request naming the field: `decodeParams`); results are
// the shapes clients read. `METHODS` is the one list the relay and the writers
// dispatch on; `WRITES` the ones a read-only connection refuses and an
// idempotency key covers.

import { Schema } from 'effect';
import { Delta, Event } from './schema-events.js';
import {
  ApiError, ApprovalAnswer, Ask, AskId, Capabilities, Count, IfBusy, QuestionAnswer, Seq, Session, SessionId, Speed, Subagent, SubagentId, TerminalId, Turn, TurnId,
} from './schema-objects.js';

const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255));
const Input = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000));
const Timing = Schema.Struct({ serverUs: Count });
const Metadata = Schema.Record(Schema.String.check(Schema.isMaxLength(40)), Schema.String.check(Schema.isMaxLength(500)));
const sid = { sessionId: SessionId };
const idem = { idempotencyKey: Schema.optionalKey(Key) };

/** Every write's answer when it may start or join a turn. */
export const SendResult = Schema.Struct({
  turn: Turn,
  delivery: Schema.Literals(['started', 'queued', 'steered']),
  duplicate: Schema.Boolean,
  seq: Seq,
  timing: Schema.optionalKey(Timing),
}).annotate({ identifier: 'SendResult' });
export const SessionResult = Schema.Struct({ session: Session, seq: Seq }).annotate({ identifier: 'SessionResult' });
export const AskResult = Schema.Struct({ ask: Ask, seq: Seq }).annotate({ identifier: 'AskResult' });

export const AttachParams = Schema.Struct({
  ...sid,
  after: Schema.optionalKey(Seq),
  tailTurns: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  deltas: Schema.optionalKey(Schema.Boolean),
  resume: Schema.optionalKey(Schema.Boolean),
  readOnly: Schema.optionalKey(Schema.Boolean),
});
export const AttachResult = Schema.Struct({
  session: Session,
  logEpoch: Count,
  epochStartSeq: Seq,
  capabilities: Capabilities,
  earlierTurns: Schema.NullOr(Schema.Array(Turn)),
  timing: Timing,
}).annotate({ identifier: 'AttachResult' });

const ApprovalOrQuestion = Schema.Union([ApprovalAnswer, QuestionAnswer]);

/** Params and result of every method; `http` is the route of the same operation (`-` when WebSocket only). */
export const METHODS = {
  'sessions.attach': { params: AttachParams, result: AttachResult, http: '-' },
  'sessions.detach': { params: Schema.Struct(sid), result: Schema.Struct({}), http: '-' },
  'sessions.get': { params: Schema.Struct({ ...sid, minSeq: Schema.optionalKey(Seq) }), result: Schema.Struct({ session: Session }), http: 'GET /sessions/{id}' },
  'sessions.update': {
    params: Schema.Struct({
      ...sid, ...idem,
      title: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
      model: Schema.optionalKey(Schema.String),
      effort: Schema.optionalKey(Schema.String),
      speed: Schema.optionalKey(Speed),
      mode: Schema.optionalKey(Schema.String),
      archived: Schema.optionalKey(Schema.Boolean),
      metadata: Schema.optionalKey(Schema.Record(Schema.String.check(Schema.isMaxLength(40)), Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))))),
    }),
    result: SessionResult, http: 'PATCH /sessions/{id}',
  },
  'sessions.interrupt': { params: Schema.Struct({ ...sid, ...idem, turnId: Schema.optionalKey(TurnId) }), result: SessionResult, http: 'POST /sessions/{id}/interrupt' },
  'sessions.compact': { params: Schema.Struct({ ...sid, ...idem, instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10_000))) }), result: SendResult, http: 'POST /sessions/{id}/compact' },
  'sessions.suspend': { params: Schema.Struct({ ...sid, ...idem, ifIdle: Schema.optionalKey(Schema.Boolean) }), result: SessionResult, http: 'POST /sessions/{id}/suspend' },
  'sessions.resume': { params: Schema.Struct({ ...sid, ...idem }), result: SessionResult, http: 'POST /sessions/{id}/resume' },
  'turns.send': { params: Schema.Struct({ ...sid, ...idem, input: Input, ifBusy: Schema.optionalKey(IfBusy) }), result: SendResult, http: 'POST /sessions/{id}/turns' },
  'turns.get': {
    params: Schema.Struct({ ...sid, turnId: TurnId, waitMs: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60_000 }))), status: Schema.optionalKey(Schema.String), minSeq: Schema.optionalKey(Seq) }),
    result: Schema.Struct({ turn: Turn }), http: 'GET /sessions/{id}/turns/{turnId}',
  },
  'turns.cancel': { params: Schema.Struct({ ...sid, ...idem, turnId: TurnId }), result: Schema.Struct({ turn: Turn, seq: Seq }), http: 'POST /sessions/{id}/turns/{turnId}/cancel' },
  'asks.list': {
    params: Schema.Struct({ ...sid, status: Schema.optionalKey(Schema.String), limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))), cursor: Schema.optionalKey(Schema.String) }),
    result: Schema.Struct({ asks: Schema.Array(Ask), nextCursor: Schema.NullOr(Schema.String) }), http: 'GET /sessions/{id}/asks',
  },
  'asks.get': { params: Schema.Struct({ ...sid, askId: AskId }), result: Schema.Struct({ ask: Ask }), http: 'GET /sessions/{id}/asks/{askId}' },
  'asks.answer': {
    params: Schema.Struct({ ...sid, ...idem, askId: AskId, answer: ApprovalOrQuestion }),
    result: AskResult, http: 'POST /sessions/{id}/asks/{askId}/answer (body: the answer)',
  },
  'asks.dismiss': { params: Schema.Struct({ ...sid, ...idem, askId: AskId, message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))) }), result: AskResult, http: 'POST /sessions/{id}/asks/{askId}/dismiss' },
  'subagents.list': {
    params: Schema.Struct({
      ...sid,
      status: Schema.optionalKey(Schema.Literals(['running', 'all'])),
      limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
      cursor: Schema.optionalKey(Schema.String),
    }),
    result: Schema.Struct({ subagents: Schema.Array(Subagent), nextCursor: Schema.NullOr(Schema.String) }), http: 'GET /sessions/{id}/subagents',
  },
  'subagents.get': { params: Schema.Struct({ ...sid, subagentId: SubagentId }), result: Schema.Struct({ subagent: Subagent }), http: 'GET /sessions/{id}/subagents/{subagentId}' },
  'subagents.stop': {
    params: Schema.Struct({ ...sid, ...idem, subagentId: SubagentId }),
    result: Schema.Struct({ subagent: Subagent, seq: Seq }), http: 'POST /sessions/{id}/subagents/{subagentId}/stop',
  },
  'events.list': {
    params: Schema.Struct({
      ...sid,
      after: Schema.optionalKey(Seq),
      limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
      waitMs: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60_000 }))),
      tailTurns: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
      turnId: Schema.optionalKey(TurnId),
      types: Schema.optionalKey(Schema.String),
    }),
    result: Schema.Struct({ events: Schema.Array(Event), earlierTurns: Schema.NullOr(Schema.Array(Turn)), lastSeq: Seq, hasMore: Schema.Boolean }),
    http: 'GET /sessions/{id}/events',
  },
  'terminals.open': {
    params: Schema.Struct({
      ...sid,
      cols: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
      rows: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
      command: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10_000))),
      tty: Schema.optionalKey(Schema.Boolean),
      term: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
    }),
    result: Schema.Struct({ terminal: Schema.Struct({ id: TerminalId, channel: Count, stderrChannel: Schema.NullOr(Count) }) }), http: '-',
  },
  'terminals.resize': {
    params: Schema.Struct({ terminalId: TerminalId, cols: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })), rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })) }),
    result: Schema.Struct({}), http: '-',
  },
  'terminals.eof': { params: Schema.Struct({ terminalId: TerminalId }), result: Schema.Struct({}), http: '-' },
  'terminals.close': { params: Schema.Struct({ terminalId: TerminalId }), result: Schema.Struct({}), http: '-' },
  ping: { params: Schema.Struct({}), result: Schema.Struct({ timing: Timing }), http: '-' },
} as const;

export type Method = keyof typeof METHODS;
export type ParamsOf<M extends Method> = (typeof METHODS)[M]['params']['Type'];
export type ResultOf<M extends Method> = (typeof METHODS)[M]['result']['Type'];

/** Methods that change a session: refused on a read-only connection, keyed for idempotency. */
export const WRITES: ReadonlySet<Method> = new Set<Method>([
  'sessions.update', 'sessions.interrupt', 'sessions.compact', 'sessions.suspend', 'sessions.resume',
  'turns.send', 'turns.cancel', 'asks.answer', 'asks.dismiss', 'subagents.stop', 'terminals.open',
]);

/** Methods a session's writer answers (the rest are the relay's own). */
export const WRITER_METHODS: ReadonlySet<Method> = new Set<Method>([
  'sessions.get', 'sessions.update', 'sessions.interrupt', 'sessions.compact', 'sessions.suspend', 'sessions.resume',
  'turns.send', 'turns.get', 'turns.cancel', 'asks.list', 'asks.get', 'asks.answer', 'asks.dismiss', 'events.list',
  'subagents.list', 'subagents.get', 'subagents.stop',
]);

export const isMethod = (m: string): m is Method => Object.hasOwn(METHODS, m);

/** Decode `params` for `method` strictly; on failure the dotted path of the first bad field. */
export function decodeParams<M extends Method>(method: M, params: unknown): { ok: true; value: ParamsOf<M> } | { ok: false; field: string; message: string } {
  const schema = METHODS[method].params as unknown as Schema.Codec<ParamsOf<M>, unknown>;
  try {
    return { ok: true, value: Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(params ?? {}) };
  } catch (e) {
    const message = String((e as Error).message ?? e);
    const at = message.match(/at \[([^\]]*)\]/)?.[1] ?? '';
    const field = at.split(',').map((p) => p.trim().replace(/^"|"$/g, '')).filter(Boolean).join('.');
    return { ok: false, field, message: message.split('\n')[0] };
  }
}

// ---------------------------------------------------------------- notifications (server → client)

export const Limits = Schema.Struct({ maxAttached: Count, maxMessageBytes: Count, maxRequestsPerSecond: Count }).annotate({ identifier: 'Limits' });

export const NOTIFICATIONS = {
  ready: Schema.Struct({
    connectionId: Schema.String,
    server: Schema.Struct({ version: Schema.String, region: Schema.NullOr(Schema.String) }),
    protocol: Schema.Struct({ features: Schema.Array(Schema.String) }),
    limits: Limits,
    expiresAt: Schema.NullOr(Schema.String),
    expiresInMs: Schema.NullOr(Count),
  }),
  'sessions.attached': Schema.Struct({
    sessionId: SessionId,
    error: Schema.NullOr(ApiError),
    session: Schema.NullOr(Session),
    logEpoch: Schema.NullOr(Count),
    epochStartSeq: Schema.NullOr(Seq),
    capabilities: Schema.NullOr(Capabilities),
    earlierTurns: Schema.NullOr(Schema.Array(Turn)),
    timing: Schema.NullOr(Schema.Struct({ serverUs: Count })),
  }),
  event: Event,
  delta: Delta,
  'session.detached': Schema.Struct({
    sessionId: SessionId,
    reason: Schema.String,
    // epoch_changed: discard from epochStartSeq and re-read from epochStartSeq - 1 (absent for other reasons).
    logEpoch: Schema.optional(Schema.Number),
    epochStartSeq: Schema.optional(Schema.Number),
  }),
  'terminal.exited': Schema.Struct({ terminalId: TerminalId, exitCode: Schema.NullOr(Schema.Int), signal: Schema.NullOr(Schema.String) }),
} as const;

/** Client → server notifications. */
export const CLIENT_NOTIFICATIONS = {
  'sessions.ack': Schema.Struct({ sessionId: SessionId, seq: Seq }),
  /** opc's own measurements (work 084 instrumentation); never answered. The relay checks each event's data against api/cli-telemetry.ts. */
  telemetry: Schema.Struct({
    v: Schema.Literals([1]),
    client: Schema.Struct({
      name: Schema.Literals(['opc']),
      version: Schema.String.check(Schema.isMaxLength(32)),
      os: Schema.optionalKey(Schema.String),
      arch: Schema.optionalKey(Schema.String),
    }),
    events: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        at: Schema.optionalKey(Schema.Number),
        sessionId: Schema.optionalKey(SessionId),
        turnId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
        data: Schema.Record(Schema.String, Schema.Union([Schema.Number, Schema.Boolean, Schema.String])),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  }),
} as const;

/** The body of `POST /sessions` (HTTP only; blue answers it, the host gets `start`). */
export const CreateSessionBody = Schema.Struct({
  id: Schema.optionalKey(SessionId),
  input: Schema.optionalKey(Input),
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  speed: Schema.optionalKey(Speed),
  mode: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Metadata),
}).annotate({ identifier: 'CreateSessionBody' });
