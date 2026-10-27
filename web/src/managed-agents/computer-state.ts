import type {
  Computer,
  ComputerAgent,
  ComputerSession,
  ComputerSessionStatus,
  ComputerStatus,
} from './computer-api'

// Presentation of the organization's computer: plain-language copy for its
// state, the setup checklist and how often the page re-reads it. Kept pure so
// the mapping is tested without rendering. Public copy names the computer by
// state and capacity only (design 002, forbidden vocabulary).

export const START_SESSION_COPY =
  'Mention @OpenComputer in any channel, or DM it.'

export type ComputerPresentation = {
  /** StatusBadge key: picks the tone and icon. */
  badge: string
  label: string
  description: string
}

/**
 * `slackInstalled`: an organization's computer comes alive when it installs
 * the Slack app, not when someone opens the page (work 052, Mohamed
 * 2026-10-13). With no computer and no Slack yet it is "not set up"; with
 * Slack installed and no computer yet it is on its way.
 */
export function computerPresentation(
  computer: Computer | null,
  plan: ComputerStatus['plan'],
  slackInstalled = false,
): ComputerPresentation {
  if (!computer && !slackInstalled) {
    return {
      badge: 'not_deployed',
      label: 'Not set up yet',
      description:
        'Invite OpenComputer to your Slack and your computer wakes up, ready in seconds.',
    }
  }
  if (!computer) {
    return {
      badge: 'starting',
      label: 'Setting up',
      description: 'We are setting up your computer. This takes a few minutes.',
    }
  }
  switch (computer.state) {
    case 'provisioning':
      return {
        badge: 'starting',
        label: 'Setting up',
        description:
          'We are setting up your computer. This takes a few minutes.',
      }
    case 'ready':
      return computer.connected
        ? {
            badge: 'running',
            label: 'Online',
            description: 'Your computer is on and ready for work.',
          }
        : {
            badge: 'stopped',
            label: 'Offline',
            description:
              'Your computer is on but not connected. It reconnects by itself, usually within a minute.',
          }
    case 'parked':
      return {
        badge: 'hibernated',
        label: 'Sleeping',
        description:
          plan === 'paid'
            ? 'Your computer is asleep. It wakes when you message it.'
            : 'Your computer is asleep. It wakes when you message it; upgrade to keep it always on.',
      }
    case 'waking':
      return {
        badge: 'starting',
        label: 'Waking',
        description:
          'Your computer is waking up with everything on its disk intact. This takes a minute or two.',
      }
    case 'failed':
      return {
        badge: 'failed',
        label: 'Failed',
        description:
          computer.lastError ??
          'Something went wrong with your computer. Try again, or contact support if it keeps failing.',
      }
    case 'deleting':
      return {
        badge: 'deleting',
        label: 'Removing',
        description: 'Your computer is being removed.',
      }
  }
}

export const BOOT_STAGES = ['Creating', 'Starting', 'Online'] as const

/**
 * How far a new computer is in coming to life, from the Slack install to
 * online: the stage it is in (the last one, Online, means done) and when it
 * began. Null when it is not booting: not set up, asleep, failed or going.
 */
export function bootProgress(
  status: ComputerStatus,
): { stage: number; since: string | null } | null {
  const { computer } = status
  if (!computer)
    return status.slack.installed ? { stage: 0, since: null } : null
  if (computer.state === 'provisioning')
    return { stage: 0, since: computer.createdAt }
  if (computer.state !== 'ready') return null
  return { stage: computer.connected ? 2 : 1, since: computer.createdAt }
}

/** Time since `iso` as a clock: "0:07", "2:41", "1:02:03". */
export function elapsedClock(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const seconds = Math.floor(Math.max(0, now - then) / 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}`
    : `${minutes}:${pad(seconds % 60)}`
}

export const FAST_POLL_MS = 5_000
export const SLOW_POLL_MS = 30_000

/**
 * Re-read quickly while something is about to change on its own (setting up,
 * waking, removing, or a running computer that has not connected yet), and
 * slowly otherwise. A sleeping or failed computer changes only on request,
 * and so does one not set up yet: it comes with the Slack install, whose
 * redirect reloads the page.
 */
export function computerPollInterval(
  status: ComputerStatus | undefined,
): number {
  if (!status) return FAST_POLL_MS
  const computer = status.computer
  if (!computer) return status.slack.installed ? FAST_POLL_MS : SLOW_POLL_MS
  switch (computer.state) {
    case 'provisioning':
    case 'waking':
    case 'deleting':
      return FAST_POLL_MS
    case 'ready':
      return computer.connected ? SLOW_POLL_MS : FAST_POLL_MS
    case 'parked':
    case 'failed':
      return SLOW_POLL_MS
  }
}

export const SETUP_STEPS = ['agent', 'slack', 'github', 'hello'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

/**
 * The setup step a person is on, or null once set up. The coding agent comes
 * first (work 081), then Slack brings the computer to life, GitHub gives it
 * the code, and the first mention in Slack finishes setup. Step 1 is done
 * once the person has connected a subscription (Claude or, since work 082,
 * a ChatGPT plan for Codex) or chosen free credits; choosing a card alone
 * keeps the step open, on reload too. It only blocks before Slack, and only when
 * the backend reports it: existing organizations (all installed) and an
 * older backend never see it, and nobody is sent back to it. Sessions not
 * read yet (or unreadable) never hold the page on setup.
 */
export function setupStep(
  status: ComputerStatus,
  sessions: ComputerSession[] | undefined,
): SetupStep | null {
  if (
    status.agent &&
    !status.slack.installed &&
    !status.agent.subscription &&
    status.agent.choice !== 'credits'
  ) {
    return 'agent'
  }
  if (!status.slack.installed) return 'slack'
  if (!status.github.connected) return 'github'
  // No computer yet (its creation is under way or failed): nothing can have
  // run, and the sessions are not even asked for.
  if (!status.computer) return 'hello'
  if (sessions?.length === 0) return 'hello'
  return null
}

/** The done row of step 1: what runs the person's threads. */
export function agentSummary(agent: ComputerAgent): string {
  if (!agent.subscription) return `${agent.managedModel} · OpenComputer credits`
  return agent.subscription.provider === 'codex'
    ? 'Codex · your ChatGPT plan'
    : 'Claude Code · your subscription'
}

/**
 * "Runs threads from @maya in Acme." on the Your agent card: the Slack user
 * the person's seat is bound to (work 081, the install link is bearer). Only
 * once Slack is installed, and only when the backend named the user: a
 * missing name, an id for a name, or no team reads as nothing rather than
 * "@U0123 in ".
 */
export function linkedSlackUserLine(
  agent: ComputerAgent,
  slackInstalled: boolean,
): string | null {
  const user = agent.linkedSlackUser
  if (!slackInstalled || !user) return null
  if (!user.name || user.name === user.id || !user.teamName) return null
  return `Runs threads from @${user.name} in ${user.teamName}.`
}

/** The lead of the last step, true to where the computer is. */
export function firstTaskLead(computer: Computer | null): string {
  const ways = 'DM it, or mention @OpenComputer in any channel.'
  if (computer?.state === 'ready' && computer.connected)
    return `Your computer is ready. ${ways}`
  if (computer?.state === 'parked')
    return `It's asleep; a message wakes it. ${ways}`
  if (computer?.state === 'failed') return ways
  return `It's still starting; message it now and it picks the task up once it's on. ${ways}`
}

/**
 * Where the last setup step sends someone: straight into a DM with the app in
 * the Slack app when the bot user is known, and the workspace in the browser.
 */
export function slackLinks(slack: ComputerStatus['slack']): {
  dm: string | null
  web: string | null
} {
  if (!slack.teamId) return { dm: null, web: null }
  const team = encodeURIComponent(slack.teamId)
  return {
    dm: slack.botUserId
      ? `slack://user?team=${team}&id=${encodeURIComponent(slack.botUserId)}`
      : null,
    web: `https://app.slack.com/client/${team}`,
  }
}

export const SESSION_STATUS: Record<
  ComputerSessionStatus,
  { badge: string; label: string }
> = {
  starting: { badge: 'starting', label: 'Starting' },
  busy: { badge: 'running', label: 'Working' },
  idle: { badge: 'idle', label: 'Idle' },
  ended: { badge: 'stopped', label: 'Ended' },
  error: { badge: 'error', label: 'Error' },
}

const SLACK_RETURN_REASONS = new Map<string, string>([
  ['access_denied', 'The Slack install was cancelled.'],
  ['cancelled', 'The Slack install was cancelled.'],
  ['invalid_state', 'The install link expired. Start the install again.'],
  ['state_expired', 'The install link expired. Start the install again.'],
  ['oauth_failed', "Slack didn't confirm the install. Try again."],
  ['slack_error', 'Slack stopped the install. Try again.'],
  [
    'enterprise_install_unsupported',
    'Enterprise Grid installs are not supported yet. Install it into a single workspace.',
  ],
  ['not_configured', 'Slack is not available right now. Try again later.'],
])

/** Reasons that mean the workspace is already another organization's. */
const ALREADY_LINKED_REASONS = new Set([
  'team_already_linked',
  'already_linked',
])

export type SlackReturn =
  | { kind: 'connected' }
  | { kind: 'error'; message: string }
  /**
   * The workspace already works with OpenComputer in another organization.
   * `notified`: the person who set it up there was asked in Slack to invite
   * this person.
   */
  | { kind: 'already_linked'; notified: boolean }
  | null

/** The query parameters Slack's install redirect adds, removed once handled. */
export const SLACK_RETURN_PARAMS = ['slack', 'reason', 'notified'] as const

/** Reads `?slack=connected|error&reason=&notified=` from Slack's install redirect. */
export function slackReturnFromSearch(search: URLSearchParams): SlackReturn {
  const slack = search.get('slack')
  if (slack === 'connected') return { kind: 'connected' }
  if (slack !== 'error') return null
  const reason = search.get('reason') ?? ''
  if (ALREADY_LINKED_REASONS.has(reason)) {
    return { kind: 'already_linked', notified: search.get('notified') === '1' }
  }
  return {
    kind: 'error',
    message:
      SLACK_RETURN_REASONS.get(reason) ??
      'Slack could not be connected. Try again.',
  }
}

/** What the already-linked panel says; the other organization is never named. */
export function alreadyLinkedCopy(notified: boolean): {
  headline: string
  body: string
} {
  return {
    headline: 'Your team is already here.',
    body: notified
      ? "Your Slack workspace already works with OpenComputer in another organization. We've messaged the person who set it up in Slack to invite you. Once you're invited, switch to that organization from the menu at the top left."
      : 'Your Slack workspace already works with OpenComputer in another organization. Ask a teammate who uses it to invite you, then switch to that organization from the menu at the top left.',
  }
}

export const EXAMPLE_ASKS = [
  'why is the checkout test flaky?',
  'walk me through how billing works in our codebase.',
  'what would break if we moved to the latest React?',
  "sketch a cleaner API for the cart service, then let's refine it.",
] as const

/**
 * Onboarded: the computer is in Slack and knows the code. From then on the
 * page stops selling and setting up, and shows the work instead (Mohamed,
 * 2026-10-11: "mainly showcase the sessions that are live").
 */
export function computerIsOnboarded(status: ComputerStatus): boolean {
  return status.slack.installed && status.github.connected
}

/** A session the computer is working on right now. */
export function sessionIsLive(session: ComputerSession): boolean {
  return session.status === 'starting' || session.status === 'busy'
}

/** Live sessions and everything else, each newest first. */
export function splitSessions(sessions: readonly ComputerSession[]): {
  live: ComputerSession[]
  recent: ComputerSession[]
} {
  const sorted = [...sessions].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  )
  return {
    live: sorted.filter(sessionIsLive),
    recent: sorted.filter((session) => !sessionIsLive(session)),
  }
}

export const LIVE_SESSION_POLL_MS = 5_000
export const SESSION_POLL_MS = 15_000

/**
 * Watch closely while something is being worked on, and while the first task
 * is awaited: setup promises to move on by itself the moment it lands.
 */
export function sessionPollInterval(
  sessions: readonly ComputerSession[] | undefined,
): number {
  if (sessions?.length === 0) return LIVE_SESSION_POLL_MS
  return sessions?.some(sessionIsLive) ? LIVE_SESSION_POLL_MS : SESSION_POLL_MS
}

/** The organization's only session, while it has had just the one. */
export function firstSession(
  sessions: readonly ComputerSession[] | undefined,
): ComputerSession | null {
  return sessions?.length === 1 ? sessions[0] : null
}

/** What the first-task panel says, true to where the task is. */
export function firstTaskCopy(status: ComputerSessionStatus): {
  headline: string
  body: string
} {
  switch (status) {
    case 'starting':
      return {
        headline: "It's picking up your first task",
        body: 'Follow along in the thread. This updates by itself.',
      }
    case 'busy':
      return {
        headline: "It's on your first task",
        body: 'Follow along in the thread, or steer it there. This updates by itself.',
      }
    case 'idle':
      return {
        headline: 'It answered your first task',
        body: 'Reply in the thread to keep going.',
      }
    case 'ended':
      return {
        headline: 'Your first task is done',
        body: `Ask again whenever you need it. ${START_SESSION_COPY}`,
      }
    case 'error':
      return {
        headline: 'Your first task hit a problem',
        body: 'Open the thread to see what happened, then ask again.',
      }
  }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "2 min ago", "3 hr ago", "yesterday", "4 days ago", then a date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const elapsed = Math.max(0, now - then)
  if (elapsed < MINUTE) return 'just now'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} hr ago`
  const days = Math.floor(elapsed / DAY)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return new Date(then).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year:
      new Date(then).getFullYear() === new Date(now).getFullYear()
        ? undefined
        : 'numeric',
  })
}
