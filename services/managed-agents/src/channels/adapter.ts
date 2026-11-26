// A channel is a conversation keyed by an external participant. Transport,
// addressing and authentication differ per provider; the thing that makes it a
// channel rather than a webhook — an inbound message continues the conversation
// it belongs to — does not.
//
// This is the seam between those two halves. Everything above it works in terms
// of `InboundChannelMessage`; everything provider-shaped lives behind a
// `ChannelAdapter`.

/** One inbound message, normalized. */
export interface InboundChannelMessage {
  /**
   * The provider's own id for this delivery. Used for idempotency, so a
   * provider that retries does not start a second turn.
   */
  id: string;
  /**
   * Who sent it, in the provider's namespace. Feeds `channelPrincipalId`,
   * which is what makes the same human the same principal across turns.
   */
  externalUserId: string;
  /**
   * Which conversation this belongs to. The continuity key, and the only
   * reason channels exist: two messages sharing one carry on one session.
   *
   * Slack composes it from channel and thread; SMS is the participant's
   * number; email is reconstructed from the References chain, which is why
   * this is a string the adapter computes rather than a field it copies.
   */
  conversationKey: string;
  /**
   * The provider's tenant this arrived under — a Slack team, a Twilio
   * account. One deployment can sit behind many of these, and an agent that
   * serves more than one needs to know which, so this is passed through to
   * the agent rather than kept for routing.
   */
  workspaceId?: string;
  /**
   * Where it was said, when the provider names conversations. Slack names
   * the thread (its `thread_ts`); SMS has only the two numbers, which
   * `conversationKey` already carries.
   */
  conversationId?: string;
  /** Human text, when the message carries any. */
  text?: string;
  /**
   * Where a reply to this message goes, in the adapter's own terms. Stored as
   * `delivery_ref` and handed back to `send` unchanged, so the shape is the
   * adapter's business and nobody else's.
   */
  replyTarget: Readonly<Record<string, unknown>>;
  /**
   * Fields the connection must match for this event to be ours — Slack's team
   * and app ids, a Twilio account SID. Compared against the stored connection by
   * `matchesConnection`.
   */
  scope: Readonly<Record<string, string | undefined>>;
  /** The provider payload, for anything downstream that still needs it. */
  data: Record<string, unknown>;
}

export interface VerifyInput {
  /** The raw request body, exactly as received. Signatures cover bytes. */
  payload: string;
  headers: Headers;
  /** The full request URL. Some providers sign it; Slack does not. */
  url: string;
  /** The provider's shared secret for this connection. */
  secret: string;
  now?: number;
}

/** Credentials and addressing a reply needs, resolved by the account. */
export interface SendInput {
  /** The adapter's own reply address, round-tripped from `delivery_ref`. */
  target: Readonly<Record<string, unknown>>;
  text: string;
  /** Provider credential: a Slack bot token, a Twilio account SID and token. */
  credential: Readonly<Record<string, unknown>>;
}

/**
 * A decision a person has taken on something the agent proposed.
 *
 * Not a message: it names a record rather than continuing a conversation, so
 * it travels a different path from `InboundChannelMessage` all the way down.
 */
export interface InboundDecision {
  approvalId: string;
  choice: "approved" | "denied";
  externalUserId: string;
  /** The message carrying the card, so it can be rewritten in place. */
  messageId?: string;
  replyTarget: Readonly<Record<string, unknown>>;
  scope: Readonly<Record<string, string | undefined>>;
}

/**
 * An `ask` question as a channel shows it (slack-ux P2): the text, one
 * button per option while it is open, and once it is resolved a line saying
 * how, with nothing left to click.
 */
export interface QuestionCard {
  questionId: string;
  /** Markdown, posted as written. */
  text: string;
  options: ReadonlyArray<{ label: string }>;
  /**
   * Post `text` as a plain message with no buttons: the gate a refused card
   * degrades to, whose options are listed in the text and answered by reply.
   */
  textGate?: boolean;
  resolved?:
    | { kind: "chosen"; choice: string; by?: string }
    | {
        kind: "closed";
        reason: "stopped" | "dismissed" | "ended" | "undeliverable" | "superseded";
      };
}

/**
 * What an open `ask` question does to the rest of a conversation. `hold`
 * (Linear, and every session without a channel): every input that does not
 * answer it waits as steering until it is answered or closed. `flow`
 * (Slack): the thread keeps moving; a click on the card answers it, any
 * other message runs as an ordinary turn that knows the question is open,
 * and the agent's next reply to the thread closes it `superseded`. A
 * `consult` holds on every channel: its answer lands as one turn.
 */
export type QuestionMode = "hold" | "flow";

/**
 * A click on one of a question card's options. Like a decision it names a
 * record (the question), not a conversation; the session it belongs to is
 * found from the clicker and the thread, as the clicker's own messages are.
 */
export interface InboundQuestionAnswer {
  questionId: string;
  optionIndex: number;
  externalUserId: string;
  /** The provider's time for the click; part of the answer's idempotency key. */
  actionTimestamp: string;
  messageId?: string;
  replyTarget: Readonly<Record<string, unknown>>;
  scope: Readonly<Record<string, string | undefined>>;
}

/** What a person is shown before they decide, in no provider's vocabulary. */
export interface ApprovalCard {
  approvalId: string;
  title: string;
  summary?: string;
  facts: ReadonlyArray<{ label: string; value: string }>;
  /** Set once decided: the card stops being a question and becomes a record. */
  decided?: {
    /**
     * `unknown` is not a hedge: a write that never reported back may well have
     * happened, and saying "failed" over a real change is worse than saying we
     * cannot tell.
     */
    choice: "approved" | "denied" | "failed" | "unknown" | "applying";
    by?: string;
    at: string;
  };
}

export interface ChannelAdapter {
  readonly provider: string;

  /**
   * Providers that require a handshake before they will deliver events answer
   * it here. Returning a Response short-circuits; returning null means this
   * body is not a handshake.
   */
  handshake?(body: unknown): Response | null;

  /**
   * Prove the request came from the provider. Called before anything is
   * trusted, and never skipped: an unverified inbound is an open door into a
   * customer's agent.
   */
  verify(input: VerifyInput): Promise<boolean>;

  /**
   * Normalize an inbound payload. Null means "nothing we act on" — a bot echo,
   * a delivery receipt, an event type we do not handle — and must be answered
   * with a success, not an error, or the provider will retry forever.
   */
  parseInbound(body: unknown, headers: Headers): InboundChannelMessage | null;

  /**
   * Does the stored connection own this? Guards against one tenant's webhook
   * being replayed at another's connection.
   *
   * Takes the scope rather than the whole message, because a decision needs
   * the same check and is not a message.
   */
  matchesConnection(
    scoped: { readonly scope: Readonly<Record<string, string | undefined>> },
    connection: Readonly<Record<string, unknown>>,
  ): boolean;

  /** Deliver the agent's reply on the conversation it came from. */
  send(input: SendInput): Promise<void>;

  /**
   * Ask for a decision, and return the id of the message that asks. Only
   * providers with something to click implement this: a card is a question
   * with buttons, and SMS has neither.
   */
  sendCard?(input: SendInput & { card: ApprovalCard }): Promise<string>;

  /**
   * Replace a message already sent. Used to turn a decided card back into a
   * record of what happened, so a stale click has nothing to click.
   */
  updateMessage?(
    input: SendInput & { messageId: string; card?: ApprovalCard },
  ): Promise<void>;

  /**
   * Read a decision out of an interaction payload. Null for interactions that
   * are not ours, which must still be answered with a success.
   */
  parseDecision?(body: unknown, headers: Headers): InboundDecision | null;

  /**
   * Post an `ask` question with its options as buttons, and return the id
   * of the message (its provider time, for Slack). Providers with nothing
   * to click do not implement it; their question is the turn's text reply.
   */
  sendQuestion?(input: SendInput & { card: QuestionCard }): Promise<string>;

  /** Rewrite a question card once it is answered or closed. */
  updateQuestion?(
    input: SendInput & { messageId: string; card: QuestionCard },
  ): Promise<void>;

  /** Read a question-option click out of an interaction payload; null when it is not one. */
  parseQuestionAnswer?(body: unknown, headers: Headers): InboundQuestionAnswer | null;

  /**
   * Can this provider show work-in-progress by editing a message it already
   * sent? Slack can, and uses it for a rotating status. SMS cannot — a text is
   * final once delivered — so progress there must be silent rather than a
   * stream of interim texts to someone's phone.
   */
  readonly editableProgress: boolean;

  /** Whether an open `ask` question holds the conversation's other inputs (`QuestionMode`). */
  readonly questionMode: QuestionMode;

  /** Longest message the provider accepts, when it has a limit worth honouring. */
  readonly maxMessageLength?: number;
}

/** Longest a provider call may take, headers and body together. */
export const PROVIDER_REQUEST_TIMEOUT_MS = 10_000;

/**
 * A provider refused for now and said when to come back. Carried on the
 * error and in its message, because the message is all that survives the
 * RPC boundary between the account and the session.
 */
export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(
      retryAfterMs === undefined
        ? message
        : `${message}; retry after ${String(Math.ceil(retryAfterMs / 1_000))}s`,
    );
  }
}

/** The wait a provider asked for, read back out of an error message. */
export function retryAfterFromMessage(message: string): number | undefined {
  const match = /; retry after (\d+)s\b/.exec(message);
  return match ? Number(match[1]) * 1_000 : undefined;
}

/** A `Retry-After` header, in milliseconds, whichever of its two forms it takes. */
export function retryAfterHeaderMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/**
 * A provider request bounded from the first byte out to the last byte in.
 * `fetch` resolves on headers; the deadline stays armed while `read` consumes
 * the body, so a provider that answers headers and then stalls cannot hold a
 * caller. A stalled call is an ordinary failure; on a channel, the delivery's
 * own schedule retries it.
 */
export async function boundedRequest<T>(
  label: string,
  input: string | URL,
  init: RequestInit,
  read: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), PROVIDER_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(input, { ...init, signal: abort.signal });
    return await read(response, abort.signal);
  } catch (error) {
    if (abort.signal.aborted) {
      throw new Error(
        `${label} timed out after ${String(PROVIDER_REQUEST_TIMEOUT_MS)} ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

const adapters = new Map<string, ChannelAdapter>();

export function registerChannelAdapter(adapter: ChannelAdapter): void {
  adapters.set(adapter.provider, adapter);
}

export function channelAdapter(provider: string): ChannelAdapter | undefined {
  return adapters.get(provider);
}

export function channelAdapterProviders(): string[] {
  return [...adapters.keys()].sort();
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Length-independent comparison, so a signature check leaks no timing. */
export function constantTimeEqual(left: string, right: string): boolean {
  const size = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < size; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function hmac(
  algorithm: "SHA-1" | "SHA-256",
  secret: string,
  message: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
}
