// The organization's computer (serverless-agents-ws work 052). The dashboard
// calls `/api/dashboard/managed-agents/computer…`; the edge proxies those
// routes to the backend's `/v1/computer…` with its org assertion. They are
// dashboard-only in v1: the API-key mount `/api/managed-agents` refuses them.
//
// Response bodies are rebuilt field by field from the binding contract, so a
// contract body passes through unchanged while anything the backend adds
// beside it (where the machine runs, what size it is) never reaches a browser.

const COMPUTER_ROUTE = /^\/computer(?:\/|$)/;

export function isComputerRouteSuffix(suffix: string): boolean {
  return COMPUTER_ROUTE.test(suffix);
}

export function isComputerRoute(method: string, suffix: string): boolean {
  if ((method === "GET" || method === "POST") && suffix === "/computer") {
    return true;
  }
  if (method === "GET" && suffix === "/computer/sessions") return true;
  if (method === "POST" && suffix === "/computer/slack/install") return true;
  if (method === "POST" && suffix === "/computer/slack/move") return true;
  if (method === "DELETE" && suffix === "/computer/slack/already-linked") {
    return true;
  }
  return method === "DELETE" && suffix === "/computer/slack";
}

// The backend's codes are stable; the messages are written here so no
// infrastructure detail (cloud, capacity pools, hosts) reaches the dashboard.
export const COMPUTER_ERROR_MESSAGES: Record<string, string> = {
  computer_not_configured:
    "Computers are not available for this organization yet.",
  computer_not_found: "This organization does not have a computer yet.",
  computer_unavailable:
    "Your computer is temporarily unavailable. Try again shortly.",
  computer_capacity_unavailable:
    "We could not set up your computer right now. Try again shortly.",
  computer_busy: "Your computer is changing state. Try again in a moment.",
  computer_slack_not_configured:
    "The OpenComputer Slack app is not available yet.",
  computer_slack_not_installed:
    "No Slack workspace is linked to this organization.",
  computer_slack_already_linked:
    "That Slack workspace is already linked to another organization.",
  computer_slack_move_unavailable:
    "There is no Slack workspace to move here. Add OpenComputer to Slack again.",
};

/** Fallback copy for a computer route when the backend's code is unknown. */
export function computerFallbackMessage(status: number): string {
  if (status === 401 || status === 403) {
    return "You do not have access to this organization's computer.";
  }
  if (status === 404) return "This organization does not have a computer yet.";
  if (status === 409) {
    return "Your computer is changing state. Try again in a moment.";
  }
  if (status === 429) return "Too many requests. Try again shortly.";
  if (status >= 500) {
    return "Your computer is temporarily unavailable. Try again shortly.";
  }
  return "The computer request could not be completed.";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function publicComputer(value: unknown): Record<string, unknown> | null {
  const computer = record(value);
  if (!computer) return null;
  return {
    state: computer.state,
    connected: computer.connected === true,
    vcpus: computer.vcpus,
    memoryGiB: computer.memoryGiB,
    diskGiB: computer.diskGiB,
    lastError: optionalString(computer.lastError),
    createdAt: computer.createdAt,
    updatedAt: computer.updatedAt,
  };
}

/** A refused install (another organization has the workspace); never names that organization. */
function publicAlreadyLinked(value: unknown) {
  const refusal = record(value);
  if (!refusal || typeof refusal.teamName !== "string") return {};
  return {
    alreadyLinked: {
      teamName: refusal.teamName,
      notified: refusal.notified === true,
      canMove: refusal.canMove === true,
    },
  };
}

function publicComputerStatus(body: Record<string, unknown>) {
  const slack = record(body.slack) ?? {};
  const github = record(body.github) ?? {};
  return {
    computer: publicComputer(body.computer),
    slack: {
      installed: slack.installed === true,
      ...(typeof slack.teamId === "string" ? { teamId: slack.teamId } : {}),
      ...(typeof slack.teamName === "string"
        ? { teamName: slack.teamName }
        : {}),
      ...(typeof slack.botUserId === "string"
        ? { botUserId: slack.botUserId }
        : {}),
      ...publicAlreadyLinked(slack.alreadyLinked),
    },
    github: {
      connected: github.connected === true,
      installations: Array.isArray(github.installations)
        ? github.installations.map((value) => {
            const installation = record(value) ?? {};
            return {
              id:
                typeof installation.id === "number"
                  ? String(installation.id)
                  : installation.id,
              accountLogin: installation.accountLogin,
            };
          })
        : [],
    },
    plan: body.plan === "paid" ? "paid" : "free",
  };
}

function httpsURL(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function publicComputerSession(value: unknown): Record<string, unknown> {
  const session = record(value) ?? {};
  return {
    key: session.key,
    title: session.title,
    channelId: session.channelId,
    threadTs: session.threadTs,
    ownerSlackUserId: optionalString(session.ownerSlackUserId),
    status: session.status,
    updatedAt: session.updatedAt,
    slackUrl: httpsURL(session.slackUrl),
  };
}

/**
 * The public body for a successful computer route. Throws on a body that
 * cannot honour the contract (the proxy turns that into its generic 502).
 */
export function publicComputerBody(
  method: string,
  suffix: string,
  value: unknown,
): unknown {
  const body = record(value) ?? {};
  if (suffix === "/computer" || suffix === "/computer/slack/move") {
    return publicComputerStatus(body);
  }
  if (method === "GET" && suffix === "/computer/sessions") {
    return {
      sessions: Array.isArray(body.sessions)
        ? body.sessions.map(publicComputerSession)
        : [],
    };
  }
  if (method === "POST" && suffix === "/computer/slack/install") {
    const url = httpsURL(body.url);
    if (!url) throw new Error("Invalid Slack install URL");
    return { url };
  }
  throw new Error("Unsupported computer response");
}

/**
 * Whether an organization has its computer (work 052 rollout). Until
 * COMPUTER_ENABLED_FOR_ALL is "true", only organizations listed in
 * COMPUTER_ENABLED_ORGS (comma-separated ids) see it; for everyone else the
 * computer routes do not exist and the dashboard hides the page.
 */
export function computerEnabledFor(
  env: { COMPUTER_ENABLED_FOR_ALL?: string; COMPUTER_ENABLED_ORGS?: string },
  orgID: string | null | undefined,
): boolean {
  if (env.COMPUTER_ENABLED_FOR_ALL === "true") return true;
  if (!orgID) return false;
  return (env.COMPUTER_ENABLED_ORGS ?? "")
    .split(",")
    .map((id) => id.trim())
    .includes(orgID);
}
