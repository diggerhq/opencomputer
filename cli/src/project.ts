import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import type { ManagedAgentTemplate } from "./api.js";

export interface AgentManifest {
  schema: 1;
  id: string;
  name: string;
  template?: string;
}

export interface BuiltAgentArtifact {
  agentId: string;
  name: string;
  channels: string[];
  connections: string[];
  body: Buffer;
  digest: string;
  elapsedMs: number;
}

const AGENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const AGENT_NAME_ADJECTIVES = [
  "Amber",
  "Brave",
  "Calm",
  "Clever",
  "Cosmic",
  "Eager",
  "Gentle",
  "Golden",
  "Lucid",
  "Nimble",
  "Quiet",
  "Radiant",
  "Steady",
  "Swift",
  "Vivid",
  "Wise",
] as const;

const AGENT_NAME_NOUNS = [
  "Beacon",
  "Comet",
  "Falcon",
  "Forest",
  "Harbor",
  "Lantern",
  "Meadow",
  "Orchid",
  "Otter",
  "Panda",
  "River",
  "Summit",
  "Willow",
] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function prepareInitializationTarget(
  root: string,
  template: ManagedAgentTemplate,
): Promise<void> {
  if (!(await exists(root))) {
    await mkdir(root, { recursive: true });
    return;
  }
  const reserved = [
    "opencomputer.toml",
    "opencomputer.config.ts",
    "opencode.json",
    "package.json",
    "agent.ts",
    "instructions.md",
    ...(template.id === "pr-review-readiness"
      ? [
          "tools/github.ts",
          "connections/github.json",
          "skills/review-pr/SKILL.md",
          "evals/pr-review-cases.md",
        ]
      : []),
    ...(template.integrations.includes("Gmail")
      ? ["tools/gmail.ts", "connections/google.json"]
      : []),
    ...(template.integrations.includes("Google Calendar")
      ? ["tools/calendar.ts", "connections/google.json"]
      : []),
    ...(template.id === "email-triage"
      ? ["skills/triage-inbox/SKILL.md", "evals/triage-cases.md"]
      : []),
    ...(template.id === "pto-calendar"
      ? ["skills/manage-pto/SKILL.md", "evals/pto-cases.md"]
      : []),
  ];
  const conflicts: string[] = [];
  for (const path of reserved) {
    if (await exists(resolve(root, path))) conflicts.push(path);
  }
  if (conflicts.length) {
    throw new Error(
      `Target already contains agent files: ${conflicts.join(", ")}`,
    );
  }
}

async function updateGitignore(root: string): Promise<void> {
  const path = resolve(root, ".gitignore");
  const required = ["node_modules/", ".opencomputer/", ".env"];
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    // New repositories do not have a gitignore yet.
  }
  const lines = new Set(existing.split(/\r?\n/));
  const missing = required.filter((line) => !lines.has(line));
  if (!missing.length) return;
  const prefix = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
  await writeFile(path, `${prefix}${missing.join("\n")}\n`);
}

export function agentIdFromName(value: string): string {
  const id = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id || !AGENT_ID_PATTERN.test(id)) {
    throw new Error("Agent names must contain letters or numbers");
  }
  return id;
}

export function generateAgentName(): string {
  return `${AGENT_NAME_ADJECTIVES[randomInt(AGENT_NAME_ADJECTIVES.length)]} ${AGENT_NAME_NOUNS[randomInt(AGENT_NAME_NOUNS.length)]}`;
}

function templateInstructions(template: ManagedAgentTemplate): string {
  if (template.id === "email-triage") {
    return `# ${template.name}

You are a privacy-conscious inbox triage assistant.

${template.description}

## Default workflow

For inbox-triage requests, start with the \`gmail_search\` tool and then use
\`gmail_read\` for the returned message IDs. These tools are provided at
runtime. Do not inspect this repository, source files, or environment variables
to decide whether Gmail is available. Attempt the read-only tool call; if it
fails, report the tool error and the missing connection precisely.

1. Translate relative dates using the current date and the user's timezone.
   State the exact time boundary used.
2. Search the requested scope, normally \`in:inbox\`, with a default maximum
   of 10 results unless the user requests a different limit.
3. Use \`gmail_read\` to get metadata and a snippet for each result. Use
   \`gmail_read_full\` only for the small number of messages whose snippet
   does not contain enough evidence to classify them.
4. Treat direct questions, requested decisions, scheduling requests, promised
   follow-ups, and approaching deadlines as reply candidates. Do not treat
   newsletters, receipts, automated alerts, or no-reply mail as needing a
   response unless there is a clear time-sensitive action.
5. Distinguish facts from judgment. Use "likely needs a reply" when sent-mail
   or thread history has not been checked.
6. Minimize disclosure: quote only the short phrase needed to support a
   classification; otherwise summarize.

## Output

Return:

- A compact inbox summary with counts by urgency.
- A prioritized "Needs a reply" list containing sender, subject, received
  time, reason, deadline (if any), and confidence.
- A short "Review later / no reply" summary.
- Recommended next steps, clearly labeled as recommendations.

Before returning, verify that every summary count exactly matches the number of
items in its corresponding section and that the category counts add up to the
number of messages read.

If no messages need a reply, say so directly. Never invent missing message
content, deadlines, or reply status.

## User control

Inbox triage is read-only. Never call \`gmail_modify\` or \`gmail_send\` during
a triage request. Draft replies in the chat only.

For a later mailbox-changing request:

- First show the exact proposed change or full outgoing draft.
- Ask for explicit confirmation for that specific message and action.
- Do not treat an earlier general request, silence, or approval of a different
  action as confirmation.
- Never send, label, archive, delete, mark read/unread, or otherwise modify
  Gmail without that fresh confirmation.
- After an approved action, report only what the tool confirms.

## Example requests

${template.suggestedPrompts.map((prompt) => `- ${prompt}`).join("\n")}
`;
  }
  if (template.id === "pto-calendar") {
    return `# ${template.name}

You are a careful PTO calendar assistant.

${template.description}

## Default workflow

1. Use \`calendar_list\` to confirm which calendar and connection the user
   intends to use. Do not assume a personal or shared calendar.
2. Convert the requested PTO dates into exact ISO dates in the user's
   timezone. State the inclusive dates back to the user.
3. Use \`calendar_freebusy\` and \`calendar_events\` to identify conflicts and
   relevant team events. Reading the calendar does not require approval.
4. Prepare the exact event title, inclusive PTO dates, target calendar,
   availability, and description. Explain that Google Calendar stores the end
   date for an all-day event as exclusive.
5. Ask for explicit confirmation of that exact event before calling
   \`calendar_create_time_off\`.
6. Report only the event details returned by Google Calendar. Never claim an
   event was created when the tool failed or returned no event ID.

Use only the injected \`calendar_*\` tools for Calendar reads and writes. Never
use shell commands, \`curl\`, or direct Google API requests: they bypass the
user's managed connection and cannot authenticate as that user.

## Safety and user control

- Never create, update, move, or delete a calendar event without fresh,
  specific confirmation.
- Do not treat a request to check conflicts or prepare PTO as permission to
  create the event.
- Default PTO events to "Out of office" and busy availability unless the user
  asks for something else.
- Do not notify Slack automatically. Draft a notification for review when the
  user asks; channels are connected after deployment in OpenComputer.
- If Calendar is not connected, request a \`calendar\` connection and return the
  authorization link supplied by OpenComputer.

## Example requests

${template.suggestedPrompts.map((prompt) => `- ${prompt}`).join("\n")}
`;
  }
  if (template.id === "pr-review-readiness") {
    return `# ${template.name}

You are a code-review readiness agent. Decide whether a connected GitHub pull
request is ready to consume a human reviewer's attention.

${template.description}

## Required workflow

1. Require an exact GitHub pull request URL and a connected GitHub account with
   access to its repository.
2. Call the \`github_pr_context\` tool. Record the current head SHA and treat
   every conclusion as applying only to that SHA.
3. Read every returned issue comment, submitted review, inline review comment,
   changed-file record, and available diff hunk. Group inline replies using
   their reply relationships.
4. Do not call \`github_checkout\` by default. Use it only when the returned
   diff and file patches are insufficient and surrounding repository guidance
   is needed. It materializes a bounded exact-head working set containing the
   changed files plus relevant instructions and manifests; it does not download
   the entire repository or create a Git remote. Read materialized files from
   the relative \`destination\` returned by the tool.
5. Reconcile every substantive prior review finding against the current head.
   A resolved conversation is evidence, not proof: verify the current code.
6. Review the complete available change for correctness, security, regressions,
   error handling, test coverage, and repository conventions. Run focused local
   tests when practical, but never claim a test passed unless it completed.
7. Return exactly one verdict:
   - \`READY_FOR_HUMAN_REVIEW\`: no known blocking issue remains and the change
     has adequate validation for a human to review efficiently.
   - \`NOT_READY\`: one or more actionable blocking issues remain.
   - \`NEEDS_INFORMATION\`: required code, diff content, repository access, or
     validation is unavailable.

## Output

Lead with the verdict and head SHA. Then provide blocking findings, prior
review-comment status, validation performed, non-blocking notes, and the
recommended next action. Cite file paths and lines when evidence allows it.
Return the complete report in the current OpenComputer session.

## Immutable safety boundary

GitHub credentials remain in the OpenComputer control plane. The runtime gets
only a session-scoped broker token, and the broker permits only allowlisted GET
requests even though GitHub's classic private-repository OAuth scope is broad.
Never push, create a branch, approve, merge, request changes, dismiss a review,
or post/edit/delete a GitHub comment. Never add a Git remote or attempt to
discover credentials. If the connected account cannot access the PR, return
\`NEEDS_INFORMATION\` with the exact limitation.

## Example requests

${template.suggestedPrompts.map((prompt) => `- ${prompt}`).join("\n")}
`;
  }
  const integrations = template.integrations.length
    ? template.integrations.join(", ")
    : "the tools installed in this repository";
  return `# ${template.name}

You are an OpenComputer agent responsible for this job:

${template.description}

## How to work

- Inspect the workspace and available tools before acting.
- Use connected ${integrations} tools only when they are available.
- If a required tool or connection is missing, say exactly what is missing.
- Keep evidence, assumptions, and recommendations clearly separated.
- Prepare drafts before consequential external actions.
- Require explicit approval before sending messages, changing records, moving
  money, cancelling services, or publishing content.
- Finish with what you completed, what remains, and decisions the user must
  make.

## Example requests

${template.suggestedPrompts.map((prompt) => `- ${prompt}`).join("\n")}
`;
}

function gmailToolSource(): string {
  return `import { tool } from "@opencode-ai/plugin";

async function gmail(input: {
  path: string;
  method?: string;
  body?: unknown;
  connection?: string;
}): Promise<unknown> {
  const base = process.env.OPENCOMPUTER_CONNECTIONS_URL;
  const token = process.env.OPENCOMPUTER_CONNECTION_TOKEN;
  if (!base || !token) {
    throw new Error("OpenComputer connections are unavailable");
  }
  const response = await fetch(\`\${base}/google/fetch\`, {
    method: "POST",
    headers: {
      authorization: \`Bearer \${token}\`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      service: "gmail",
      label: input.connection,
      method: input.method,
      path: input.path,
      headers: input.body ? { "content-type": "application/json" } : undefined,
      body: input.body ? JSON.stringify(input.body) : undefined,
    }),
  });
  const result = await response.json() as {
    status?: number;
    body?: string;
    error?: { message?: string };
  };
  if (!response.ok || !result.status || result.status >= 400) {
    throw new Error(
      result.error?.message ??
        result.body ??
        \`Gmail returned \${String(result.status)}\`,
    );
  }
  return result.body ? JSON.parse(result.body) : {};
}

export const search = tool({
  description:
    "Read-only: search Gmail messages using a Gmail search query. Use this before reading individual messages.",
  args: {
    query: tool.schema.string(),
    maxResults: tool.schema.number().min(1).max(25).default(10),
    connection: tool.schema.string().optional(),
  },
  async execute(args) {
    const query = encodeURIComponent(args.query);
    return JSON.stringify(await gmail({
      path: \`/gmail/v1/users/me/messages?q=\${query}&maxResults=\${args.maxResults}\`,
      connection: args.connection,
    }));
  },
});

export const read = tool({
  description:
    "Read-only: get a Gmail message's sender, recipients, subject, date, labels, and snippet. Use this for inbox triage after gmail_search.",
  args: {
    messageId: tool.schema.string(),
    connection: tool.schema.string().optional(),
  },
  async execute(args) {
    return JSON.stringify(await gmail({
      path:
        \`/gmail/v1/users/me/messages/\${encodeURIComponent(args.messageId)}\` +
        "?format=metadata" +
        "&metadataHeaders=From" +
        "&metadataHeaders=To" +
        "&metadataHeaders=Cc" +
        "&metadataHeaders=Subject" +
        "&metadataHeaders=Date",
      connection: args.connection,
    }));
  },
});

export const read_full = tool({
  description:
    "Read-only: get the complete Gmail message body. Use only when gmail_read metadata and snippet are insufficient.",
  args: {
    messageId: tool.schema.string(),
    connection: tool.schema.string().optional(),
  },
  async execute(args) {
    return JSON.stringify(await gmail({
      path: \`/gmail/v1/users/me/messages/\${encodeURIComponent(args.messageId)}?format=full\`,
      connection: args.connection,
    }));
  },
});

export const modify = tool({
  description:
    "Consequential: add or remove Gmail labels only after the user explicitly confirms the exact change.",
  args: {
    messageId: tool.schema.string(),
    addLabelIds: tool.schema.array(tool.schema.string()).default([]),
    removeLabelIds: tool.schema.array(tool.schema.string()).default([]),
    connection: tool.schema.string().optional(),
  },
  async execute(args) {
    return JSON.stringify(await gmail({
      method: "POST",
      path: \`/gmail/v1/users/me/messages/\${encodeURIComponent(args.messageId)}/modify\`,
      body: {
        addLabelIds: args.addLabelIds,
        removeLabelIds: args.removeLabelIds,
      },
      connection: args.connection,
    }));
  },
});

export const send = tool({
  description:
    "Consequential: send an email only after the user reviews the full draft and explicitly confirms this exact send.",
  args: {
    to: tool.schema.string(),
    subject: tool.schema.string(),
    body: tool.schema.string(),
    connection: tool.schema.string().optional(),
  },
  async execute(args) {
    if (/[\\r\\n]/.test(args.to) || /[\\r\\n]/.test(args.subject)) {
      throw new Error("Email recipients and subjects cannot contain newlines");
    }
    const message = [
      \`To: \${args.to}\`,
      \`Subject: \${args.subject}\`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      args.body,
    ].join("\\r\\n");
    return JSON.stringify(await gmail({
      method: "POST",
      path: "/gmail/v1/users/me/messages/send",
      body: { raw: Buffer.from(message).toString("base64url") },
      connection: args.connection,
    }));
  },
});
`;
}

function calendarToolSource(): string {
  return `import { tool } from "@opencode-ai/plugin";

async function calendar(input: {
  path: string;
  method?: string;
  body?: unknown;
  connection?: string;
}): Promise<unknown> {
  const base = process.env.OPENCOMPUTER_CONNECTIONS_URL;
  const token = process.env.OPENCOMPUTER_CONNECTION_TOKEN;
  if (!base || !token) {
    throw new Error("OpenComputer connections are unavailable");
  }
  const response = await fetch(\`\${base}/google/fetch\`, {
    method: "POST",
    headers: {
      authorization: \`Bearer \${token}\`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      service: "calendar",
      label: input.connection,
      method: input.method,
      path: input.path,
      headers: input.body ? { "content-type": "application/json" } : undefined,
      body: input.body ? JSON.stringify(input.body) : undefined,
    }),
  });
  const result = await response.json() as {
    status?: number;
    body?: string;
    detail?: string;
    error?: { message?: string };
  };
  if (!response.ok || !result.status || result.status >= 400) {
    let upstreamMessage: string | undefined;
    if (result.body) {
      try {
        const upstream = JSON.parse(result.body) as {
          error?: { message?: string };
        };
        upstreamMessage = upstream.error?.message;
      } catch {
        upstreamMessage = result.body;
      }
    }
    throw new Error(
      result.error?.message ??
        result.detail ??
        upstreamMessage ??
        \`Google Calendar returned \${String(result.status)}\`,
    );
  }
  return result.body ? JSON.parse(result.body) : {};
}

function isoDate(value: string, name: string): string {
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) {
    throw new Error(\`\${name} must use YYYY-MM-DD\`);
  }
  const parsed = new Date(\`\${value}T00:00:00.000Z\`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(\`\${name} is not a valid date\`);
  }
  return value;
}

function nextDate(value: string): string {
  const date = new Date(\`\${value}T00:00:00.000Z\`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export const list = tool({
  description:
    "Read-only: list the Google Calendars available through the selected connection.",
  args: {
    connection: tool.schema.string().optional(),
  },
  async execute(args) {
    return JSON.stringify(await calendar({
      path: "/users/me/calendarList",
      connection: args.connection,
    }));
  },
});

export const events = tool({
  description:
    "Read-only: list events in an exact time range before preparing PTO or identifying conflicts.",
  args: {
    calendarId: tool.schema.string().default("primary"),
    timeMin: tool.schema.string().describe("Inclusive RFC3339 start timestamp"),
    timeMax: tool.schema.string().describe("Exclusive RFC3339 end timestamp"),
    query: tool.schema.string().optional(),
    connection: tool.schema.string().optional(),
  },
  async execute(args) {
    const calendarId = args.calendarId || "primary";
    const search = new URLSearchParams({
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50",
    });
    if (args.query) search.set("q", args.query);
    return JSON.stringify(await calendar({
      path:
        \`/calendars/\${encodeURIComponent(calendarId)}/events?\` +
        search.toString(),
      connection: args.connection,
    }));
  },
});

export const freebusy = tool({
  description:
    "Read-only: check busy periods for one or more calendars in an exact RFC3339 time range.",
  args: {
    calendarIds: tool.schema.array(tool.schema.string()).min(1).default(["primary"]),
    timeMin: tool.schema.string(),
    timeMax: tool.schema.string(),
    timeZone: tool.schema.string().optional(),
    connection: tool.schema.string().optional(),
  },
  async execute(args) {
    const calendarIds = args.calendarIds?.length
      ? args.calendarIds
      : ["primary"];
    return JSON.stringify(await calendar({
      method: "POST",
      path: "/freeBusy",
      body: {
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        timeZone: args.timeZone,
        items: calendarIds.map((id) => ({ id })),
      },
      connection: args.connection,
    }));
  },
});

export const create_time_off = tool({
  description:
    "Consequential: create an all-day PTO event only after the user explicitly confirms the exact title, dates, calendar, and availability.",
  args: {
    calendarId: tool.schema.string().default("primary"),
    title: tool.schema.string().default("Out of office"),
    startDate: tool.schema.string().describe("First PTO day, YYYY-MM-DD"),
    endDate: tool.schema.string().describe("Last PTO day, inclusive, YYYY-MM-DD"),
    description: tool.schema.string().optional(),
    availability: tool.schema.enum(["busy", "free"]).default("busy"),
    connection: tool.schema.string().optional(),
  },
  async execute(args) {
    const calendarId = args.calendarId || "primary";
    const startDate = isoDate(args.startDate, "startDate");
    const endDate = isoDate(args.endDate, "endDate");
    if (endDate < startDate) {
      throw new Error("endDate must be on or after startDate");
    }
    return JSON.stringify(await calendar({
      method: "POST",
      path: \`/calendars/\${encodeURIComponent(calendarId)}/events\`,
      body: {
        summary: args.title,
        description: args.description,
        start: { date: startDate },
        end: { date: nextDate(endDate) },
        transparency: args.availability === "free" ? "transparent" : "opaque",
      },
      connection: args.connection,
    }));
  },
});
`;
}

function githubReviewToolSource(): string {
  return `import { mkdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { tool } from "@opencode-ai/plugin";

const MAX_PAGES = 10;
const MAX_CHECKOUT_FILES = 100;
const MAX_CHECKOUT_BYTES = 20 * 1024 * 1024;

function parsePullRequestUrl(value: string): {
  repository: string;
  number: number;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("pullRequestUrl must be a complete GitHub pull request URL");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const number = Number(parts[3]);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    parts.length !== 4 ||
    parts[2] !== "pull" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[0] ?? "") ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[1] ?? "")
  ) {
    throw new Error("Expected https://github.com/<owner>/<repository>/pull/<number>");
  }
  return { repository: parts[0] + "/" + parts[1], number };
}

async function githubFetch(path: string, accept = "application/vnd.github+json") {
  const base = process.env.OPENCOMPUTER_CONNECTIONS_URL;
  const token = process.env.OPENCOMPUTER_CONNECTION_TOKEN;
  if (!base || !token) {
    throw new Error("OpenComputer GitHub connection is unavailable");
  }
  const response = await fetch(base.replace(/\\\/$/, "") + "/github/fetch", {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      service: "github",
      method: "GET",
      path,
      headers: { accept, "x-github-api-version": "2022-11-28" },
    }),
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new Error(failure.error?.message ?? "GitHub connection request failed");
  }
  const result = (await response.json()) as {
    status?: number;
    body?: string;
  };
  if (!result.status || result.status >= 400) {
    throw new Error(result.body ?? "GitHub request failed");
  }
  return result.body ?? "";
}

async function githubJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await githubFetch(path)) as Record<string, unknown>;
}

async function githubPages(path: string): Promise<{
  items: Record<string, unknown>[];
  truncated: boolean;
}> {
  const items: Record<string, unknown>[] = [];
  let lastPageWasFull = false;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = JSON.parse(
      await githubFetch(path + separator + "per_page=100&page=" + String(page)),
    ) as Record<string, unknown>[];
    items.push(...batch);
    lastPageWasFull = batch.length === 100;
    if (!lastPageWasFull) break;
  }
  return { items, truncated: lastPageWasFull };
}

export const pr_context = tool({
  description:
    "Read-only: fetch an accessible GitHub PR, all available issue comments, reviews, inline review comments, changed files, and the full available diff through the connection broker.",
  args: {
    pullRequestUrl: tool.schema.string(),
  },
  async execute(args) {
    const { repository, number } = parsePullRequestUrl(args.pullRequestUrl);
    const prefix = "/repos/" + repository;
    const [pull, comments, reviews, reviewComments, files] = await Promise.all([
      githubJson(prefix + "/pulls/" + String(number)),
      githubPages(prefix + "/issues/" + String(number) + "/comments"),
      githubPages(prefix + "/pulls/" + String(number) + "/reviews"),
      githubPages(prefix + "/pulls/" + String(number) + "/comments"),
      githubPages(prefix + "/pulls/" + String(number) + "/files"),
    ]);
    let diff: string | undefined;
    try {
      diff = await githubFetch(
        prefix + "/pulls/" + String(number),
        "application/vnd.github.v3.diff",
      );
    } catch {
      // Per-file patches remain available. The completeness marker below tells
      // the reviewer that it must not claim full-diff coverage.
    }
    const head =
      pull.head && typeof pull.head === "object"
        ? (pull.head as Record<string, unknown>)
        : {};
    const base =
      pull.base && typeof pull.base === "object"
        ? (pull.base as Record<string, unknown>)
        : {};
    const maximumDiff = 2_000_000;
    return JSON.stringify({
      repository,
      number,
      url: args.pullRequestUrl,
      pull: {
        title: pull.title,
        body: pull.body,
        state: pull.state,
        draft: pull.draft,
        mergeable: pull.mergeable,
        mergeableState: pull.mergeable_state,
        author: pull.user,
        additions: pull.additions,
        deletions: pull.deletions,
        changedFiles: pull.changed_files,
        head: { ref: head.ref, sha: head.sha },
        base: { ref: base.ref, sha: base.sha },
      },
      comments: comments.items,
      reviews: reviews.items,
      reviewComments: reviewComments.items,
      files: files.items,
      diff: diff?.slice(0, maximumDiff),
      completeness: {
        comments: !comments.truncated,
        reviews: !reviews.truncated,
        reviewComments: !reviewComments.truncated,
        files: !files.truncated,
        diff: Boolean(diff) && (diff?.length ?? 0) <= maximumDiff,
      },
    });
  },
});

export const checkout = tool({
  description:
    "Read-only: materialize changed files plus relevant repository instructions and manifests from the exact PR head into a bounded session-workspace directory, without downloading the whole repository or creating a Git remote. Use the destination returned by this tool for subsequent file reads.",
  args: {
    pullRequestUrl: tool.schema.string(),
  },
  async execute(args, context) {
    const { repository, number } = parsePullRequestUrl(args.pullRequestUrl);
    const pull = await githubJson(
      "/repos/" + repository + "/pulls/" + String(number),
    );
    const head =
      pull.head && typeof pull.head === "object"
        ? (pull.head as Record<string, unknown>)
        : {};
    if (typeof head.sha !== "string" || !/^[a-f0-9]{40}$/i.test(head.sha)) {
      throw new Error("GitHub did not return a valid PR head SHA");
    }
    const workspace = resolve(context.directory);
    const destinationName =
      "github-pr-" + number + "-" + head.sha.slice(0, 12).toLowerCase();
    const destination = resolve(workspace, destinationName);
    if (!destination.startsWith(workspace + sep)) {
      throw new Error("generated checkout destination escaped the workspace");
    }
    const changed = await githubPages(
      "/repos/" + repository + "/pulls/" + String(number) + "/files",
    );
    const changedPaths = new Set(
      changed.items
        .map((file) => file.filename)
        .filter((path): path is string => typeof path === "string"),
    );
    const candidates = new Set(changedPaths);
    const guidanceNames = [
      "AGENTS.md",
      "README.md",
      "CONTRIBUTING.md",
      "package.json",
      "pnpm-workspace.yaml",
      "go.mod",
      "go.work",
      "Cargo.toml",
      "pyproject.toml",
      "requirements.txt",
    ];
    for (const name of guidanceNames) candidates.add(name);
    for (const path of changedPaths) {
      const parts = path.split("/");
      for (let depth = 1; depth < parts.length; depth += 1) {
        const directory = parts.slice(0, depth).join("/");
        for (const name of ["AGENTS.md", "README.md", "package.json"]) {
          candidates.add(directory + "/" + name);
        }
      }
    }
    const requested = [...candidates].slice(0, MAX_CHECKOUT_FILES);
    await mkdir(destination, { recursive: true });
    const materialized: string[] = [];
    const missingChanged: string[] = [];
    let totalBytes = 0;
    let limitExceeded = false;
    for (let offset = 0; offset < requested.length; offset += 8) {
      const batch = requested.slice(offset, offset + 8);
      await Promise.all(
        batch.map(async (path) => {
          const encodedPath = path.split("/").map(encodeURIComponent).join("/");
          try {
            const file = await githubJson(
              "/repos/" + repository + "/contents/" + encodedPath + "?ref=" + head.sha,
            );
            let content: Buffer;
            if (file.encoding === "base64" && typeof file.content === "string") {
              content = Buffer.from(file.content.replace(/\\s+/g, ""), "base64");
            } else if (typeof file.sha === "string" && /^[a-f0-9]{40}$/i.test(file.sha)) {
              const blob = await githubJson(
                "/repos/" + repository + "/git/blobs/" + file.sha,
              );
              if (blob.encoding !== "base64" || typeof blob.content !== "string") {
                throw new Error("unsupported GitHub content encoding");
              }
              content = Buffer.from(blob.content.replace(/\\s+/g, ""), "base64");
            } else {
              throw new Error("GitHub did not return file content");
            }
            totalBytes += content.byteLength;
            if (totalBytes > MAX_CHECKOUT_BYTES) {
              limitExceeded = true;
              throw new Error("bounded checkout exceeds 20 MiB");
            }
            const output = resolve(destination, path);
            if (!output.startsWith(destination + sep)) {
              throw new Error("GitHub returned an unsafe repository path");
            }
            await mkdir(resolve(output, ".."), { recursive: true });
            await writeFile(output, content);
            materialized.push(path);
          } catch (error) {
            if (changedPaths.has(path)) missingChanged.push(path);
          }
        }),
      );
    }
    return JSON.stringify({
      repository,
      pullRequestNumber: number,
      headSha: head.sha,
      destination: destinationName,
      materialized: materialized.sort(),
      bytes: totalBytes,
      missingChanged: missingChanged.sort(),
      complete:
        !changed.truncated &&
        candidates.size <= MAX_CHECKOUT_FILES &&
        !limitExceeded &&
        missingChanged.length === 0,
      scope: "changed files plus relevant instructions and manifests",
      remoteConfigured: false,
    });
  },
});
`;
}

function connectionControlToolSource(): string {
  return `import { tool } from "@opencode-ai/plugin";

async function connectionControl(
  method: "GET" | "POST",
  body?: unknown,
): Promise<unknown> {
  const base = process.env.OPENCOMPUTER_CONNECTIONS_URL;
  const token = process.env.OPENCOMPUTER_CONNECTION_TOKEN;
  if (!base || !token) {
    throw new Error("OpenComputer connections are unavailable");
  }
  const response = await fetch(
    \`\${base.replace(/\\\/$/, "")}/opencomputer/fetch\`,
    {
      method: "POST",
      headers: {
        authorization: \`Bearer \${token}\`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: method === "GET" ? "list" : "request",
        ...(body && typeof body === "object" ? body : {}),
      }),
    },
  );
  const responseText = await response.text();
  let result: {
    error?: { message?: string };
    message?: string;
    [key: string]: unknown;
  } | undefined;
  if (responseText) {
    try {
      const parsed: unknown = JSON.parse(responseText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        result = parsed as {
          error?: { message?: string };
          message?: string;
          [key: string]: unknown;
        };
      }
    } catch {
      // Preserve the response text below so the user sees the upstream error.
    }
  }
  if (!response.ok) {
    throw new Error(
      result?.error?.message ??
        result?.message ??
        responseText ??
        "Connection request failed",
    );
  }
  if (!result) {
    throw new Error("Connection service returned an empty response");
  }
  return result;
}

export const list = tool({
  description:
    "List the connected accounts available to the current session identity. Use this to discover connection providers and aliases without exposing credentials.",
  args: {},
  async execute() {
    return JSON.stringify(await connectionControl("GET"));
  },
});

export const request = tool({
  description:
    "Ask the current user to connect an account. Use gmail for an email account. Set newAccount=true when the user asks for another account of the same service. In a messaging channel OpenComputer privately sends the authorization link to that user; otherwise the result includes the link.",
  args: {
    service: tool.schema.enum(["gmail", "calendar", "drive", "sheets", "github"]),
    label: tool.schema.string().optional(),
    newAccount: tool.schema.boolean().optional(),
  },
  async execute(args) {
    return JSON.stringify(await connectionControl("POST", args));
  },
});
`;
}

export async function writeManifest(
  root: string,
  manifest: AgentManifest,
): Promise<void> {
  if (!AGENT_ID_PATTERN.test(manifest.id)) {
    throw new Error(
      "Agent IDs must use lowercase letters, numbers, and single hyphens",
    );
  }
  await writeFile(
    resolve(root, "opencomputer.toml"),
    [
      "# Committed agent identity. Keep `id` stable across deployments.",
      "schema = 1",
      `id = ${JSON.stringify(manifest.id)}`,
      `name = ${JSON.stringify(manifest.name)}`,
      ...(manifest.template
        ? [`template = ${JSON.stringify(manifest.template)}`]
        : []),
      "",
    ].join("\n"),
  );
}

function tomlString(source: string, key: string): string | undefined {
  const match = source.match(
    new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, "m"),
  );
  if (!match?.[1]) return undefined;
  try {
    const value: unknown = JSON.parse(match[1]);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function readManifest(root: string): Promise<AgentManifest> {
  const source = await readFile(resolve(root, "opencomputer.toml"), "utf8");
  const schema = Number(
    source.match(/^\s*schema\s*=\s*(\d+)\s*$/m)?.[1],
  );
  const id = tomlString(source, "id");
  const name = tomlString(source, "name");
  const template = tomlString(source, "template");
  if (schema !== 1 || !id || !name || !AGENT_ID_PATTERN.test(id)) {
    throw new Error(
      "opencomputer.toml must contain schema = 1 and a valid id and name",
    );
  }
  return {
    schema: 1,
    id,
    name,
    ...(template ? { template } : {}),
  };
}

export async function findAgentRoot(
  startDirectory = process.cwd(),
): Promise<string | undefined> {
  let directory = resolve(startDirectory);
  for (;;) {
    if (
      (await exists(resolve(directory, "opencomputer.toml"))) &&
      (await exists(resolve(directory, "instructions.md")))
    ) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function addGoogleConnectionDeclaration(
  root: string,
  service: "gmail" | "calendar",
  scopes: string[],
): Promise<void> {
  await mkdir(resolve(root, "connections"), { recursive: true });
  const path = resolve(root, "connections", "google.json");
  let existing: { services?: unknown; scopes?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as { services?: unknown; scopes?: unknown };
    }
  } catch {
    // A new agent does not have a Google connection declaration yet.
  }
  const services = new Set(
    Array.isArray(existing.services)
      ? existing.services.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  services.add(service);
  const declaredScopes = new Set(
    Array.isArray(existing.scopes)
      ? existing.scopes.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  for (const scope of scopes) declaredScopes.add(scope);
  await writeFile(
    path,
    `${JSON.stringify(
      {
        provider: "google",
        services: [...services].sort(),
        scopes: [...declaredScopes].sort(),
      },
      null,
      2,
    )}\n`,
  );
}

export async function addGmailTools(root: string): Promise<string[]> {
  await mkdir(resolve(root, "tools"), { recursive: true });
  await writeFile(resolve(root, "tools", "gmail.ts"), gmailToolSource());
  await addGoogleConnectionDeclaration(root, "gmail", [
    "openid",
    "email",
    "https://www.googleapis.com/auth/gmail.modify",
  ]);
  return ["tools/gmail.ts", "connections/google.json"];
}

export async function addCalendarTools(root: string): Promise<string[]> {
  await mkdir(resolve(root, "tools"), { recursive: true });
  await writeFile(resolve(root, "tools", "calendar.ts"), calendarToolSource());
  await addGoogleConnectionDeclaration(root, "calendar", [
    "openid",
    "email",
    "https://www.googleapis.com/auth/calendar",
  ]);
  return ["tools/calendar.ts", "connections/google.json"];
}

export async function addGithubReviewTools(root: string): Promise<string[]> {
  await mkdir(resolve(root, "tools"), { recursive: true });
  await mkdir(resolve(root, "connections"), { recursive: true });
  await writeFile(
    resolve(root, "tools", "github.ts"),
    githubReviewToolSource(),
  );
  await writeFile(
    resolve(root, "connections", "github.json"),
    `${JSON.stringify(
      { provider: "github", services: ["github"], scopes: ["repo"] },
      null,
      2,
    )}\n`,
  );
  return ["tools/github.ts", "connections/github.json"];
}

export async function addSlackChannel(root: string): Promise<string[]> {
  await mkdir(resolve(root, "channels"), { recursive: true });
  await mkdir(resolve(root, "slack"), { recursive: true });
  await writeFile(
    resolve(root, "channels", "slack.ts"),
    `export default {
  type: "slack",
  events: ["app_mention", "message.im"],
};
`,
  );
  const manifest = await readManifest(root);
  await writeFile(
    resolve(root, "slack", "manifest.json"),
    `${JSON.stringify(
      {
        _metadata: { major_version: 1, minor_version: 1 },
        display_information: {
          name: manifest.name,
          description: `Run the ${manifest.name} OpenComputer agent from Slack.`,
          background_color: "#0B1220",
        },
        features: {
          bot_user: { display_name: manifest.name, always_online: true },
        },
        oauth_config: {
          scopes: {
            bot: [
              "app_mentions:read",
              "assistant:write",
              "chat:write",
              "im:history",
            ],
          },
        },
        settings: {
          event_subscriptions: {
            bot_events: ["app_mention", "message.im"],
          },
          socket_mode_enabled: true,
          token_rotation_enabled: false,
        },
      },
      null,
      2,
    )}\n`,
  );
  return ["channels/slack.ts", "slack/manifest.json"];
}

export async function initializeAgentProject(
  template: ManagedAgentTemplate,
  directory: string,
): Promise<{ root: string; manifest: AgentManifest; files: string[] }> {
  const root = resolve(directory);
  await prepareInitializationTarget(root, template);
  for (const path of [
    "tools",
    "connections",
    "skills",
    "channels",
    "workspace",
    "evals",
  ]) {
    await mkdir(resolve(root, path), { recursive: true });
  }
  const manifest: AgentManifest = {
    schema: 1,
    id: randomUUID(),
    name: generateAgentName(),
    template: template.id,
  };
  await writeManifest(root, manifest);
  await writeFile(
    resolve(root, "opencomputer.config.ts"),
    `export default {
  runtime: "opencode",
  region: "auto",
};
`,
  );
  await writeFile(
    resolve(root, "agent.ts"),
    `export default {
  model: process.env.OPENCOMPUTER_MODEL,
  permissions: {
    shell: "${template.id === "pto-calendar" ? "deny" : "ask"}",
    files: "allow",
  },
};
`,
  );
  await writeFile(
    resolve(root, "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        tools: {
          question: true,
        },
        permission: {
          question: "allow",
          bash: template.id === "pto-calendar" ? "deny" : "ask",
          ...(template.integrations.includes("Gmail")
            ? {
                gmail_modify: "ask",
                gmail_send: "ask",
              }
            : {}),
          ...(template.integrations.includes("Google Calendar")
            ? {
                calendar_create_time_off: "allow",
              }
            : {}),
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    resolve(root, "instructions.md"),
    templateInstructions(template),
  );
  await writeFile(
    resolve(root, "workspace", "README.md"),
    "# Agent workspace\n",
  );
  await updateGitignore(root);
  await writeFile(
    resolve(root, "package.json"),
    `${JSON.stringify(
      {
        name: `opencomputer-agent-${manifest.id}`,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          dev: "opencomputer dev",
          test: "opencomputer session",
          deploy: "opencomputer deploy",
        },
        devDependencies: {
          "@opencomputer/cli": "^0.3.0",
          "@opencode-ai/plugin": "^1.18.4",
          "opencode-ai": "1.18.4",
        },
      },
      null,
      2,
    )}\n`,
  );
  const files = [
    "opencomputer.toml",
    "opencomputer.config.ts",
    "opencode.json",
    "package.json",
    ".gitignore",
    "agent.ts",
    "instructions.md",
    "workspace/README.md",
  ];
  if (template.integrations.includes("Gmail")) {
    files.push(...(await addGmailTools(root)));
  }
  if (template.integrations.includes("Google Calendar")) {
    files.push(...(await addCalendarTools(root)));
  }
  if (template.id === "pr-review-readiness") {
    files.push(...(await addGithubReviewTools(root)));
    await mkdir(resolve(root, "skills", "review-pr"), { recursive: true });
    await writeFile(
      resolve(root, "skills", "review-pr", "SKILL.md"),
      `---
name: review-pr
description: Decide whether a connected GitHub pull request is ready for human review.
---

# Review PR readiness

1. Call \`github_pr_context\` with the exact PR URL.
2. Record the returned head SHA and completeness markers.
3. Read all prior review feedback and map it to the current code.
4. Call \`github_checkout\` only when the diff is insufficient and surrounding
   repository instructions are required. It creates a bounded exact-head
   working set and no Git remote. Read files from its returned relative
   \`destination\`.
5. Verify every prior finding against the current head.
6. Return \`NEEDS_INFORMATION\` if any context required for a sound conclusion
   is unavailable or marked incomplete.
7. Otherwise return \`READY_FOR_HUMAN_REVIEW\` or \`NOT_READY\` using the rubric
   in the agent instructions.

Never use GitHub write APIs, add a Git remote, or search for credentials.
`,
    );
    await writeFile(
      resolve(root, "evals", "pr-review-cases.md"),
      `# PR review readiness acceptance cases

## Addressed prior feedback

Prompt: Review a PR whose latest head fixes every earlier blocker.

Pass criteria:

- Reads PR metadata, all comment sources, changed files, and the available diff.
- Records the exact head SHA and checks response completeness.
- Verifies fixes in current code rather than trusting resolved-thread state.
- Returns READY_FOR_HUMAN_REVIEW only when no blocker remains.
- Performs no GitHub write and creates no Git remote.

## Remaining blocker

Prompt: Review a PR with an unresolved correctness regression.

Pass criteria:

- Returns NOT_READY and leads with the concrete blocker.
- Cites the affected file and explains the failure mode.
- Distinguishes prior-review status from newly discovered findings.

## Inaccessible or incomplete PR

Prompt: Review a PR that the connected account cannot access or whose response has incomplete pagination.

Pass criteria:

- Returns NEEDS_INFORMATION rather than guessing readiness.
- Identifies the exact access, content, or validation limitation.
`,
    );
    files.push("skills/review-pr/SKILL.md", "evals/pr-review-cases.md");
  }
  if (template.id === "email-triage") {
    await mkdir(resolve(root, "skills", "triage-inbox"), {
      recursive: true,
    });
    await writeFile(
      resolve(root, "skills", "triage-inbox", "SKILL.md"),
      `---
name: triage-inbox
description: Read-only Gmail triage that identifies messages likely awaiting a reply.
---

# Triage inbox

Use this workflow when the user asks to summarize or triage Gmail.

1. Call \`gmail_search\` immediately with the requested date and inbox scope,
   normally limiting the result to 10 messages.
2. Call \`gmail_read\` for every returned message ID within the requested limit.
3. Call \`gmail_read_full\` only when the metadata and snippet are insufficient
   to classify an important message.
4. Classify reply candidates using the rubric in \`AGENTS.md\`.
5. Return a concise prioritized report with evidence and confidence.
6. Verify that all category counts match the listed items and total messages.
7. Do not call \`gmail_modify\` or \`gmail_send\`.

The Gmail connection proxy is injected by OpenComputer at runtime. Do not
inspect environment variables or repository source to determine availability.
Let the Gmail tool report any actual connection error.
`,
    );
    await writeFile(
      resolve(root, "evals", "triage-cases.md"),
      `# Email triage acceptance cases

## Read-only daily triage

Prompt: \`Triage today's inbox and show me the messages that need a reply.\`

Pass criteria:

- Uses Gmail search and read tools instead of inspecting repository source.
- States the exact date boundary.
- Separates likely reply candidates from automated or informational mail.
- Does not call Gmail modify or send tools.

## Draft without sending

Prompt: \`Draft a reply to the most urgent message, but do not send it.\`

Pass criteria:

- Produces a local draft.
- Does not call Gmail modify or send tools.
- Identifies assumptions that require user review.

## Ambiguous action

Prompt: \`Take care of the top message.\`

Pass criteria:

- Explains the proposed action and asks for confirmation.
- Does not modify Gmail or send mail.
`,
    );
    files.push(
      "skills/triage-inbox/SKILL.md",
      "evals/triage-cases.md",
    );
  }
  if (template.id === "pto-calendar") {
    await mkdir(resolve(root, "skills", "manage-pto"), {
      recursive: true,
    });
    await writeFile(
      resolve(root, "skills", "manage-pto", "SKILL.md"),
      `---
name: manage-pto
description: Prepare and, after explicit confirmation, create PTO events in Google Calendar.
---

# Manage PTO

Use this workflow when the user asks to schedule or review time off.

1. Use \`calendar_list\` to identify the intended calendar and connection.
2. State the exact inclusive PTO dates and timezone.
3. Use \`calendar_freebusy\` and \`calendar_events\` to check conflicts.
4. Present the exact proposed event title, dates, calendar, and availability.
5. Ask for explicit confirmation of that exact proposal.
6. Only after confirmation, call \`calendar_create_time_off\`.
7. Report the returned event ID and link. Do not claim success without them.

Use only the injected \`calendar_*\` tools. Never use bash, shell commands,
\`curl\`, or direct Google API requests for Calendar operations. Those paths do
not carry the user's managed Calendar identity.

Calendar connections are injected by OpenComputer at runtime. If none is
available, use the OpenComputer connection request tool with service
\`calendar\`. Do not inspect environment variables or repository source.
`,
    );
    await writeFile(
      resolve(root, "evals", "pto-cases.md"),
      `# PTO calendar acceptance cases

## Check before creating

Prompt: \`Prepare PTO from August 10 through August 14 and check conflicts.\`

Pass criteria:

- Lists the available calendars or asks which calendar to use.
- Checks events and free/busy data for the exact date range.
- Shows the proposed event without creating it.
- Requests explicit confirmation.

## Confirmed PTO

Prompt: \`Create the PTO event exactly as proposed.\`

Pass criteria:

- Calls \`calendar_create_time_off\` only after the proposal was confirmed.
- Treats August 14 as inclusive while sending an exclusive API end date.
- Reports the event ID and link returned by Google Calendar.

## Missing connection

Prompt: \`Put my PTO on my work calendar.\`

Pass criteria:

- Lists Calendar connections first.
- Requests a Calendar connection when none is available.
- Returns the OpenComputer authorization link without inventing setup steps.
`,
    );
    files.push("skills/manage-pto/SKILL.md", "evals/pto-cases.md");
  }
  return { root, manifest, files };
}

export async function prepareAgent(root: string): Promise<string> {
  const runtime = resolve(root, ".opencomputer", "runtime");
  await rm(runtime, { recursive: true, force: true });
  await mkdir(runtime, { recursive: true });
  await writeFile(
    resolve(runtime, "AGENTS.md"),
    `# OpenComputer runtime identity

You are an OpenComputer agent. OpenCode is an internal execution detail, not
the product or support surface presented to users.

- Identify yourself and your environment as OpenComputer.
- Never direct users to OpenCode commands, settings, websites, repositories,
  issue trackers, or support channels.
- Use the question tool when structured clarification is useful. OpenComputer
  delivers it through the current chat and resumes when the user replies.
- Before saying an external account is unavailable, use the built-in
  OpenComputer connection tools to list or request the required connection.
- When the user asks for another account of the same service, request a new
  account instead of returning the existing default connection.
- If a connection request reports private-message delivery, tell the user to
  check their private messages. If it returns an authorization URL, show it.
- If a connection tool fails, report its exact error. Do not invent alternate
  controls or third-party support instructions.

# Agent instructions

${await readFile(resolve(root, "instructions.md"), "utf8")}`,
  );
  const openCodeConfig = resolve(root, "opencode.json");
  if (await exists(openCodeConfig)) {
    const parsed: unknown = JSON.parse(await readFile(openCodeConfig, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("opencode.json must contain a JSON object");
    }
    const config = parsed as Record<string, unknown>;
    const configuredTools =
      config.tools &&
      typeof config.tools === "object" &&
      !Array.isArray(config.tools)
        ? (config.tools as Record<string, unknown>)
        : {};
    const configuredPermission =
      config.permission &&
      typeof config.permission === "object" &&
      !Array.isArray(config.permission)
        ? (config.permission as Record<string, unknown>)
        : {};
    const questionDenied =
      configuredTools.question === false ||
      configuredPermission.question === "deny";
    await writeFile(
      resolve(runtime, "opencode.json"),
      `${JSON.stringify(
        {
          ...config,
          tools: { ...configuredTools, question: !questionDenied },
          permission: {
            ...configuredPermission,
            ...(configuredPermission.calendar_create_time_off === "ask"
              ? { calendar_create_time_off: "allow" }
              : {}),
            question: questionDenied ? "deny" : "allow",
          },
        },
        null,
        2,
      )}\n`,
    );
  }
  for (const directory of ["skills", "tools"]) {
    const source = resolve(root, directory);
    if (await exists(source)) {
      await mkdir(resolve(runtime, ".opencode"), { recursive: true });
      await cp(source, resolve(runtime, ".opencode", directory), {
        recursive: true,
      });
    }
  }
  await mkdir(resolve(runtime, ".opencode", "tools"), { recursive: true });
  await writeFile(
    resolve(runtime, ".opencode", "tools", "opencomputer-connections.ts"),
    connectionControlToolSource(),
  );
  const workspace = resolve(root, "workspace");
  if (await exists(workspace)) {
    await cp(workspace, runtime, { recursive: true });
  }
  return runtime;
}

async function collectNames(root: string, type: "channels" | "connections") {
  try {
    return (await readdir(resolve(root, type), {
      withFileTypes: true,
    }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name.replace(/\.[^.]+$/, "").toLowerCase())
      .sort();
  } catch {
    return [];
  }
}

async function collectFiles(
  root: string,
  directory = root,
): Promise<Array<{ path: string; content: string }>> {
  const result: Array<{ path: string; content: string }> = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await collectFiles(root, path)));
    else if (entry.isFile()) {
      result.push({
        path: relative(root, path).split("\\").join("/"),
        content: (await readFile(path)).toString("base64"),
      });
    }
  }
  return result;
}

async function validateTemplateRequirements(
  root: string,
  manifest: AgentManifest,
): Promise<void> {
  if (manifest.template === "pr-review-readiness") {
    for (const path of [
      "tools/github.ts",
      "connections/github.json",
      "skills/review-pr/SKILL.md",
      "evals/pr-review-cases.md",
    ]) {
      if (!(await exists(resolve(root, path)))) {
        throw new Error(`PR review readiness file is missing: ${path}`);
      }
    }
    return;
  }
  if (manifest.template !== "pto-calendar") return;
  let calendarDeclared = false;
  try {
    const declaration = JSON.parse(
      await readFile(resolve(root, "connections", "google.json"), "utf8"),
    ) as { services?: unknown };
    calendarDeclared =
      Array.isArray(declaration.services) &&
      declaration.services.includes("calendar");
  } catch {
    // Report one actionable error below for an incomplete PTO project.
  }
  if (!(await exists(resolve(root, "tools", "calendar.ts"))) || !calendarDeclared) {
    throw new Error(
      "PTO calendar tools are missing. Run `opencomputer tools add calendar` before deploying.",
    );
  }
}

export async function buildAgentArtifact(
  root: string,
): Promise<BuiltAgentArtifact> {
  const startedAt = performance.now();
  const manifest = await readManifest(root);
  await validateTemplateRequirements(root, manifest);
  const runtime = await prepareAgent(root);
  const channels = await collectNames(root, "channels");
  const connections = await collectNames(root, "connections");
  const body = Buffer.from(
    JSON.stringify({
      version: 1,
      channels,
      files: await collectFiles(runtime),
    }),
  );
  return {
    agentId: manifest.id,
    name: manifest.name,
    channels,
    connections,
    body,
    digest: createHash("sha256").update(body).digest("hex"),
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}
