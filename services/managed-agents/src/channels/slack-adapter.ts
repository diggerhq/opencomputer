import type {
  ApprovalCard,
  ChannelAdapter,
  InboundChannelMessage,
  InboundDecision,
  InboundQuestionAnswer,
  QuestionCard,
  VerifyInput,
} from "./adapter.js";
import { parseSlackEventCallback, verifySlackSignature } from "./slack-events.js";
import {
  postSlackBlocks,
  postSlackMessage,
  type SlackBlock,
  updateSlackBlocks,
} from "./slack-api.js";
import { isRecord } from "../protocol.js";

/** Namespaced so a click can be told apart from any other button in Slack. */
const APPROVE_ACTION = "opencomputer_approval_approve";
const DENY_ACTION = "opencomputer_approval_deny";

/**
 * Every option button of a question card. Slack refuses two elements with
 * the same `action_id` in one block, so each button carries its index as a
 * suffix and a click is recognized by the prefix; the option itself rides in
 * `value` as `<questionId>:<index>`.
 */
export const QUESTION_ACTION = "opencomputer_question_answer";

/** Slack's button label limit. */
const BUTTON_LABEL_LIMIT = 75;

/**
 * A Slack timestamp (`"1712345678.123456"`, seconds and microseconds) as
 * ISO 8601, to the millisecond. Message and click times compare on Slack's
 * own clock this way: a reply is an answer when its `ts` is later than the
 * question card's.
 */
export function slackTimestampIso(ts: string | null | undefined): string | undefined {
  if (typeof ts !== "string") return undefined;
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(ts);
  if (!match) return undefined;
  const millis =
    Number(match[1]) * 1000 + Math.floor(Number((match[2] ?? "").padEnd(6, "0")) / 1000);
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** Slack's cap on the text of `markdown` blocks in one message. */
export const SLACK_MARKDOWN_BLOCK_LIMIT = 12_000;

/** Ends a snapshot cut to fit beside its question. */
export const SNAPSHOT_TRIMMED_NOTE = "… (trimmed; the full text is in the session)";

/**
 * A question message's markdown: the turn's snapshot (its final text), a
 * blank line, then the question and its `suffix` (options line, ↗ link).
 * Within Slack's markdown block cap, the snapshot gives way, never the
 * question: it is cut and marked so.
 */
export function questionMarkdown(input: {
  snapshot?: string;
  question: string;
  suffix: string;
}): string {
  const tail = `${input.question}${input.suffix}`;
  const snapshot = input.snapshot?.trim();
  if (!snapshot) return tail;
  const room = SLACK_MARKDOWN_BLOCK_LIMIT - tail.length - 2;
  if (snapshot.length <= room) return `${snapshot}\n\n${tail}`;
  const keep = Math.max(0, room - SNAPSHOT_TRIMMED_NOTE.length - 1);
  return `${snapshot.slice(0, keep).trimEnd()}\n${SNAPSHOT_TRIMMED_NOTE}\n\n${tail}`;
}

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** What a superseded card says under its text: the conversation moved on in the thread. */
export const QUESTION_SUPERSEDED_LABEL = "answered in the thread";

function questionResolvedLabel(resolved: NonNullable<QuestionCard["resolved"]>): string {
  if (resolved.kind === "closed") {
    return resolved.reason === "superseded"
      ? QUESTION_SUPERSEDED_LABEL
      : `closed (${resolved.reason})`;
  }
  const who = resolved.by ? ` · by <@${resolved.by}>` : "";
  return `chosen: ${escapeMrkdwn(resolved.choice)}${who}`;
}

function questionText(card: QuestionCard): string {
  const resolved = card.resolved ? `\n${questionResolvedLabel(card.resolved)}` : "";
  return `${card.text}${resolved}`;
}

function questionBlocks(card: QuestionCard): SlackBlock[] {
  const blocks: SlackBlock[] = [{ type: "markdown", text: card.text }];
  if (card.resolved) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: questionResolvedLabel(card.resolved) }],
    });
    // No actions block: a resolved question has nothing left to click.
    return blocks;
  }
  if (card.options.length) {
    blocks.push({
      type: "actions",
      elements: card.options.slice(0, 10).map((option, index) => ({
        type: "button",
        text: {
          type: "plain_text",
          text:
            option.label.length > BUTTON_LABEL_LIMIT
              ? `${option.label.slice(0, BUTTON_LABEL_LIMIT - 1)}…`
              : option.label,
        },
        action_id: `${QUESTION_ACTION}:${String(index)}`,
        value: `${card.questionId}:${String(index)}`,
      })),
    });
  }
  return blocks;
}

function decidedLabel(choice: NonNullable<ApprovalCard["decided"]>["choice"]): string {
  if (choice === "approved") return "Approved";
  if (choice === "denied") return "Not approved";
  if (choice === "failed") return "Failed to apply";
  if (choice === "applying") return "Approved · applying now";
  return "Could not confirm this completed — check before retrying";
}

function cardText(card: ApprovalCard): string {
  const lines = [card.title];
  if (card.summary) lines.push(card.summary);
  for (const fact of card.facts) lines.push(`${fact.label}: ${fact.value}`);
  if (card.decided) lines.push(decidedLabel(card.decided.choice));
  return lines.join("\n");
}

function cardBlocks(card: ApprovalCard): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${card.title}*` },
    },
  ];
  if (card.summary) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: card.summary },
    });
  }
  if (card.facts.length) {
    blocks.push({
      type: "section",
      // Slack lays fields out in two columns and takes at most ten.
      fields: card.facts.slice(0, 10).map((fact) => ({
        type: "mrkdwn",
        text: `*${fact.label}*\n${fact.value}`,
      })),
    });
  }
  if (card.decided) {
    const what = decidedLabel(card.decided.choice);
    const who = card.decided.by ? ` by <@${card.decided.by}>` : "";
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `${what}${who} · ${card.decided.at}` }],
    });
    // No actions block: a decided card has nothing left to click, which is
    // what stops a second click from arriving at all.
    return blocks;
  }
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: "Approve" },
        action_id: APPROVE_ACTION,
        value: card.approvalId,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Cancel" },
        action_id: DENY_ACTION,
        value: card.approvalId,
      },
    ],
  });
  return blocks;
}

/**
 * Slack behind the adapter seam. The verification and parsing are the existing
 * functions unchanged; what is new is naming the two things every provider has
 * to answer — who sent this, and which conversation is it part of.
 */
export const slackAdapter: ChannelAdapter = {
  provider: "slack",

  // Slack can edit a message it already posted, which is how the rotating
  // "Thinking..." status works.
  editableProgress: true,

  // A question does not hold the thread: typed replies run as they come,
  // and the card's buttons answer until the agent's next reply.
  questionMode: "flow",

  handshake(body) {
    if (!isRecord(body) || body.type !== "url_verification") return null;
    return typeof body.challenge === "string"
      ? Response.json({ challenge: body.challenge })
      : Response.json(
          { error: "invalid_slack_challenge" },
          { status: 400 },
        );
  },

  verify({ payload, headers, secret, now }: VerifyInput) {
    return verifySlackSignature(payload, headers, secret, now);
  },

  parseInbound(body): InboundChannelMessage | null {
    const callback = parseSlackEventCallback(body);
    if (!callback) return null;
    const event = callback.data;
    const channel = typeof event.channel === "string" ? event.channel : "";
    if (!channel) return null;
    // Bot messages echo back through the events API; acting on them is how an
    // agent ends up talking to itself.
    if (event.bot_id !== undefined || event.subtype === "bot_message") {
      return null;
    }
    const user = typeof event.user === "string" ? event.user : "";
    if (!user) return null;
    // A threaded reply belongs to its thread; a top-level message opens one.
    const thread =
      typeof event.thread_ts === "string"
        ? event.thread_ts
        : typeof event.ts === "string"
          ? event.ts
          : "";
    return {
      id: callback.id,
      externalUserId: user,
      // Scoped to the speaker as well as the thread, which is deliberate and
      // long-standing: two people in one Slack thread get separate sessions,
      // so one person's agent state is never handed to another. Changing this
      // to a thread-wide key would also orphan every conversation already
      // bound under it.
      conversationKey: `${user}:${thread}`,
      workspaceId: callback.teamId,
      conversationId: channel,
      replyTarget: { channelId: channel, threadTimestamp: thread },
      ...(typeof event.text === "string" ? { text: event.text } : {}),
      scope: { teamId: callback.teamId, appId: callback.appId },
      data: event,
    };
  },

  async send({ target, text, credential }) {
    const token = credential.botToken;
    if (typeof token !== "string" || !token) {
      throw new Error("Slack connection has no bot token");
    }
    const channel = target.channelId;
    const thread = target.threadTimestamp;
    if (typeof channel !== "string" || typeof thread !== "string") {
      throw new Error("Slack reply is missing a channel or thread");
    }
    await postSlackMessage(token, {
      channelId: channel,
      threadTimestamp: thread,
      text,
    });
  },

  async sendCard({ target, credential, card }) {
    const token = credential.botToken;
    if (typeof token !== "string" || !token) {
      throw new Error("Slack connection has no bot token");
    }
    const channel = target.channelId;
    const thread = target.threadTimestamp;
    if (typeof channel !== "string" || typeof thread !== "string") {
      throw new Error("Slack card is missing a channel or thread");
    }
    return postSlackBlocks(token, {
      channelId: channel,
      threadTimestamp: thread,
      text: cardText(card),
      blocks: cardBlocks(card),
    });
  },

  async updateMessage({ target, credential, messageId, card, text }) {
    const token = credential.botToken;
    if (typeof token !== "string" || !token) {
      throw new Error("Slack connection has no bot token");
    }
    const channel = target.channelId;
    if (typeof channel !== "string") {
      throw new Error("Slack update is missing a channel");
    }
    await updateSlackBlocks(token, {
      channelId: channel,
      messageId,
      text: card ? cardText(card) : text,
      blocks: card
        ? cardBlocks(card)
        : [{ type: "section", text: { type: "mrkdwn", text } }],
    });
  },

  async sendQuestion({ target, credential, card }) {
    const token = credential.botToken;
    if (typeof token !== "string" || !token) {
      throw new Error("Slack connection has no bot token");
    }
    const channel = target.channelId;
    const thread = target.threadTimestamp;
    if (typeof channel !== "string" || typeof thread !== "string") {
      throw new Error("Slack question is missing a channel or thread");
    }
    if (card.textGate) {
      return postSlackMessage(token, { channelId: channel, threadTimestamp: thread, text: card.text });
    }
    return postSlackBlocks(token, {
      channelId: channel,
      threadTimestamp: thread,
      text: questionText(card),
      blocks: questionBlocks(card),
    });
  },

  async updateQuestion({ target, credential, messageId, card }) {
    const token = credential.botToken;
    if (typeof token !== "string" || !token) {
      throw new Error("Slack connection has no bot token");
    }
    const channel = target.channelId;
    if (typeof channel !== "string") {
      throw new Error("Slack update is missing a channel");
    }
    await updateSlackBlocks(token, {
      channelId: channel,
      messageId,
      text: questionText(card),
      blocks: questionBlocks(card),
    });
  },

  parseQuestionAnswer(body): InboundQuestionAnswer | null {
    if (!isRecord(body) || body.type !== "block_actions") return null;
    const actions = Array.isArray(body.actions) ? body.actions : [];
    const action = actions.find(
      (candidate) =>
        isRecord(candidate) &&
        typeof candidate.action_id === "string" &&
        candidate.action_id.startsWith(`${QUESTION_ACTION}:`),
    );
    if (!isRecord(action) || typeof action.value !== "string") return null;
    const split = action.value.lastIndexOf(":");
    const questionId = split > 0 ? action.value.slice(0, split) : "";
    const optionIndex = Number(action.value.slice(split + 1));
    if (!questionId || !Number.isInteger(optionIndex) || optionIndex < 0) return null;
    const actionTimestamp = typeof action.action_ts === "string" ? action.action_ts : undefined;
    const user = isRecord(body.user) ? body.user.id : undefined;
    const channel = isRecord(body.channel) ? body.channel.id : undefined;
    const message = isRecord(body.message) ? body.message : undefined;
    const messageId = message && typeof message.ts === "string" ? message.ts : undefined;
    const threadTimestamp =
      message && typeof message.thread_ts === "string" ? message.thread_ts : messageId;
    if (
      typeof user !== "string" ||
      typeof channel !== "string" ||
      !actionTimestamp ||
      !threadTimestamp
    ) {
      return null;
    }
    const team = isRecord(body.team) ? body.team.id : undefined;
    return {
      questionId,
      optionIndex,
      externalUserId: user,
      actionTimestamp,
      ...(messageId ? { messageId } : {}),
      replyTarget: { channelId: channel, threadTimestamp },
      scope: {
        teamId: typeof team === "string" ? team : undefined,
        appId: typeof body.api_app_id === "string" ? body.api_app_id : undefined,
      },
    };
  },

  parseDecision(body): InboundDecision | null {
    if (!isRecord(body) || body.type !== "block_actions") return null;
    const actions = Array.isArray(body.actions) ? body.actions : [];
    const action = actions.find(
      (candidate) =>
        isRecord(candidate) &&
        (candidate.action_id === APPROVE_ACTION ||
          candidate.action_id === DENY_ACTION),
    );
    // Every other button in the workspace reaches this endpoint too.
    if (!isRecord(action) || typeof action.value !== "string") return null;
    const user = isRecord(body.user) ? body.user.id : undefined;
    const channel = isRecord(body.channel) ? body.channel.id : undefined;
    const message = isRecord(body.message) ? body.message : undefined;
    const messageId = message && typeof message.ts === "string" ? message.ts : undefined;
    const threadTimestamp =
      message && typeof message.thread_ts === "string"
        ? message.thread_ts
        : messageId;
    if (typeof user !== "string" || typeof channel !== "string") return null;
    const team = isRecord(body.team) ? body.team.id : undefined;
    return {
      approvalId: action.value,
      choice: action.action_id === APPROVE_ACTION ? "approved" : "denied",
      externalUserId: user,
      ...(messageId ? { messageId } : {}),
      replyTarget: { channelId: channel, threadTimestamp: threadTimestamp ?? "" },
      scope: {
        teamId: typeof team === "string" ? team : undefined,
        appId: typeof body.api_app_id === "string" ? body.api_app_id : undefined,
      },
    };
  },

  matchesConnection(message, connection) {
    if (connection.status !== "connected") return false;
    if (connection.teamId !== message.scope.teamId) return false;
    // Older connections predate appId; only enforce it when it is recorded.
    return (
      !connection.appId || connection.appId === message.scope.appId
    );
  },
};
