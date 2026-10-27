import { describe, expect, it } from 'vitest'
import {
  computerSessionsSchema,
  computerStatusSchema,
  computerSlackInstallSchema,
  type Computer,
  type ComputerAgent,
  type ComputerSession,
  type ComputerStatus,
} from './computer-api'
import {
  FAST_POLL_MS,
  LIVE_SESSION_POLL_MS,
  SESSION_POLL_MS,
  SLOW_POLL_MS,
  agentSummary,
  computerIsOnboarded,
  computerPollInterval,
  computerPresentation,
  firstTaskLead,
  linkedSlackUserLine,
  setupStep,
  slackLinks,
  relativeTime,
  sessionPollInterval,
  alreadyLinkedCopy,
  firstSession,
  firstTaskCopy,
  bootProgress,
  elapsedClock,
  slackReturnFromSearch,
  splitSessions,
} from './computer-state'

const computer: Computer = {
  state: 'ready',
  connected: true,
  vcpus: 2,
  memoryGiB: 8,
  diskGiB: 128,
  lastError: null,
  createdAt: '2026-10-11T10:00:00.000Z',
  updatedAt: '2026-10-11T10:05:00.000Z',
}

function status(overrides: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    computer,
    slack: { installed: false },
    github: { connected: false, installations: [] },
    plan: 'free',
    ...overrides,
  }
}

const FORBIDDEN = /azure|aws|gcp|cloud|region|instance|vm\b|host/i

describe('computer contract schemas', () => {
  it('parses the GET /computer body, with and without a computer', () => {
    expect(
      computerStatusSchema.parse({
        computer,
        slack: { installed: true, teamId: 'T1', teamName: 'Acme' },
        github: {
          connected: true,
          installations: [{ id: '42', accountLogin: 'acme' }],
        },
        plan: 'paid',
      }),
    ).toMatchObject({ slack: { teamName: 'Acme' }, plan: 'paid' })
    expect(
      computerStatusSchema.parse({
        computer: null,
        slack: { installed: false },
        github: { connected: false, installations: [] },
        plan: 'free',
      }).computer,
    ).toBeNull()
  })

  it('rejects states and plans outside the contract', () => {
    expect(
      computerStatusSchema.safeParse(
        status({ computer: { ...computer, state: 'sleeping' as never } }),
      ).success,
    ).toBe(false)
    expect(
      computerStatusSchema.safeParse({ ...status(), plan: 'enterprise' })
        .success,
    ).toBe(false)
  })

  it('parses sessions and the Slack install URL', () => {
    expect(
      computerSessionsSchema.parse({
        sessions: [
          {
            key: 'C1:1.2',
            title: 'Fix it',
            channelId: 'C1',
            threadTs: '1.2',
            ownerSlackUserId: null,
            status: 'idle',
            updatedAt: '2026-10-11T10:05:00.000Z',
            slackUrl: null,
          },
        ],
      }).sessions,
    ).toHaveLength(1)
    expect(
      computerSlackInstallSchema.safeParse({ url: 'not a url' }).success,
    ).toBe(false)
  })
})

describe('computer state copy', () => {
  it.each([
    [null, 'Not set up yet'],
    [{ ...computer, state: 'provisioning' as const }, 'Setting up'],
    [computer, 'Online'],
    [{ ...computer, connected: false }, 'Offline'],
    [{ ...computer, state: 'parked' as const, connected: false }, 'Sleeping'],
    [{ ...computer, state: 'waking' as const, connected: false }, 'Waking'],
    [{ ...computer, state: 'failed' as const }, 'Failed'],
    [{ ...computer, state: 'deleting' as const }, 'Removing'],
  ])('labels %o as %s without naming the infrastructure', (value, label) => {
    const presentation = computerPresentation(value, 'free')
    expect(presentation.label).toBe(label)
    expect(presentation.description).not.toMatch(FORBIDDEN)
  })

  it('is not set up before the Slack install, and setting up once Slack is in', () => {
    expect(computerPresentation(null, 'free')).toMatchObject({
      badge: 'not_deployed',
      label: 'Not set up yet',
    })
    expect(computerPresentation(null, 'free').description).toContain('Slack')
    expect(computerPresentation(null, 'free', true).label).toBe('Setting up')
  })

  it('suggests an upgrade only to free organizations whose computer sleeps', () => {
    const parked = { ...computer, state: 'parked' as const }
    expect(computerPresentation(parked, 'free').description).toContain(
      'wakes when you message it; upgrade to keep it always on',
    )
    expect(computerPresentation(parked, 'paid').description).not.toContain(
      'upgrade',
    )
  })

  it('shows the last error of a failed computer', () => {
    expect(
      computerPresentation(
        { ...computer, state: 'failed', lastError: 'Setup timed out.' },
        'free',
      ).description,
    ).toBe('Setup timed out.')
  })
})

describe('computer polling', () => {
  it('polls quickly while the computer is changing or not connected', () => {
    expect(computerPollInterval(undefined)).toBe(FAST_POLL_MS)
    // Slack installed and the computer on its way.
    expect(
      computerPollInterval(
        status({ computer: null, slack: { installed: true, teamId: 'T1' } }),
      ),
    ).toBe(FAST_POLL_MS)
    for (const state of ['provisioning', 'waking', 'deleting'] as const) {
      expect(
        computerPollInterval(status({ computer: { ...computer, state } })),
      ).toBe(FAST_POLL_MS)
    }
    expect(
      computerPollInterval(
        status({ computer: { ...computer, connected: false } }),
      ),
    ).toBe(FAST_POLL_MS)
  })

  it('polls slowly once online, asleep or failed, and before the Slack install', () => {
    expect(computerPollInterval(status())).toBe(SLOW_POLL_MS)
    expect(computerPollInterval(status({ computer: null }))).toBe(SLOW_POLL_MS)
    for (const state of ['parked', 'failed'] as const) {
      expect(
        computerPollInterval(
          status({ computer: { ...computer, state, connected: false } }),
        ),
      ).toBe(SLOW_POLL_MS)
    }
  })
})

describe('computer setup', () => {
  const slack = { installed: true, teamName: 'Acme' }
  const github = {
    connected: true,
    installations: [{ id: '1', accountLogin: 'acme' }],
  }

  it('walks Slack, then GitHub, then the first mention', () => {
    expect(setupStep(status({ computer: null }), undefined)).toBe('slack')
    // GitHub connected first still leaves Slack to do.
    expect(setupStep(status({ github }), [])).toBe('slack')
    expect(setupStep(status({ slack }), [])).toBe('github')
    expect(setupStep(status({ slack, github }), [])).toBe('hello')
    expect(setupStep(status({ slack, github }), [{} as never])).toBeNull()
  })

  it('stays on the last step while there is no computer', () => {
    // Slack's claim failed: sessions are not asked for, so none can show.
    expect(
      setupStep(status({ slack, github, computer: null }), undefined),
    ).toBe('hello')
  })

  it('says ready only when it is', () => {
    expect(firstTaskLead(computer)).toMatch(/^Your computer is ready\./)
    for (const state of ['provisioning', 'waking', 'failed', 'parked'] as const)
      expect(firstTaskLead({ ...computer, state })).not.toContain('ready')
    expect(firstTaskLead(null)).toContain('still starting')
  })

  it('never holds the page on setup for sessions it could not read', () => {
    expect(setupStep(status({ slack, github }), undefined)).toBeNull()
  })
})

describe('choosing the coding agent (work 081)', () => {
  const slack = { installed: true, teamName: 'Acme' }
  const fresh: ComputerAgent = {
    choice: null,
    linked: false,
    subscription: null,
    managedModel: 'Claude Opus 5.5',
  }
  const connected: ComputerAgent = {
    ...fresh,
    choice: 'claude',
    subscription: {
      provider: 'claude',
      health: 'ok',
      setAt: '2026-10-22T10:00:00.000Z',
    },
  }

  it('comes first for a fresh organization', () => {
    expect(setupStep(status({ agent: fresh }), undefined)).toBe('agent')
  })

  it('moves on once free credits are chosen or a subscription connected', () => {
    const credits = { ...fresh, choice: 'credits' as const }
    expect(setupStep(status({ agent: credits }), undefined)).toBe('slack')
    expect(setupStep(status({ agent: connected }), undefined)).toBe('slack')
    // A subscription without a recorded choice still counts.
    expect(
      setupStep(status({ agent: { ...connected, choice: null } }), undefined),
    ).toBe('slack')
  })

  it('never sends an installed organization back to it', () => {
    expect(setupStep(status({ slack, agent: fresh }), [])).toBe('github')
  })

  it('is skipped by an older backend that sends no agent', () => {
    expect(setupStep(status(), undefined)).toBe('slack')
    expect(
      computerStatusSchema.parse({
        computer: null,
        slack: { installed: false },
        github: { connected: false, installations: [] },
        plan: 'free',
      }).agent,
    ).toBeUndefined()
  })

  it('keeps Codex on the step, on a later visit too', () => {
    // Codex records interest and runs nothing yet: the step ends only with
    // a subscription or free credits, so a reload lands on it again.
    const codex = { ...fresh, choice: 'codex' as const }
    expect(setupStep(status({ agent: codex }), undefined)).toBe('agent')
    expect(setupStep(status({ slack, agent: codex }), [])).toBe('github')
    expect(
      setupStep(
        status({ agent: { ...connected, choice: 'codex' } }),
        undefined,
      ),
    ).toBe('slack')
  })

  it('names the linked Slack user only once Slack is in and the name is one', () => {
    const user = { id: 'U1', name: 'maya', teamName: 'Acme' }
    const linked = { ...connected, linked: true, linkedSlackUser: user }
    expect(linkedSlackUserLine(linked, true)).toBe(
      'Runs threads from @maya in Acme.',
    )
    expect(linkedSlackUserLine(linked, false)).toBeNull()
    expect(linkedSlackUserLine(connected, true)).toBeNull()
    for (const bad of [
      { ...user, name: '' },
      { ...user, name: 'U1' },
      { ...user, teamName: '' },
    ]) {
      expect(
        linkedSlackUserLine({ ...linked, linkedSlackUser: bad }, true),
      ).toBeNull()
    }
  })

  it('names what runs the threads', () => {
    expect(agentSummary(connected)).toBe('Claude Code · your subscription')
    expect(agentSummary({ ...fresh, choice: 'credits' })).toBe(
      'Claude Opus 5.5 · OpenComputer credits',
    )
    expect(
      agentSummary({
        ...connected,
        choice: 'codex',
        subscription: {
          ...connected.subscription!,
          provider: 'codex',
          plan: 'plus',
        },
      }),
    ).toBe('Codex · your ChatGPT plan')
  })

  it('parses the agent block and refuses unknown health', () => {
    const body = {
      computer: null,
      slack: { installed: false },
      github: { connected: false, installations: [] },
      plan: 'free',
      agent: {
        ...connected,
        linked: true,
        linkedSlackUser: { id: 'U1', name: 'maya', teamName: 'Acme' },
      },
    }
    expect(computerStatusSchema.parse(body).agent).toEqual(body.agent)
    expect(() =>
      computerStatusSchema.parse({
        ...body,
        agent: {
          ...body.agent,
          subscription: { ...connected.subscription, health: 'weird' },
        },
      }),
    ).toThrow()
  })
})

describe('Slack links', () => {
  it('opens a DM with the app when the bot is known', () => {
    expect(
      slackLinks({ installed: true, teamId: 'T1', botUserId: 'UBOT' }),
    ).toEqual({
      dm: 'slack://user?team=T1&id=UBOT',
      web: 'https://app.slack.com/client/T1',
    })
    expect(slackLinks({ installed: true, teamId: 'T1' })).toEqual({
      dm: null,
      web: 'https://app.slack.com/client/T1',
    })
    expect(slackLinks({ installed: false })).toEqual({ dm: null, web: null })
  })
})

describe('Slack install return', () => {
  it('reads connected and error returns', () => {
    expect(
      slackReturnFromSearch(new URLSearchParams('slack=connected')),
    ).toEqual({ kind: 'connected' })
    expect(
      slackReturnFromSearch(
        new URLSearchParams('slack=error&reason=access_denied'),
      ),
    ).toEqual({ kind: 'error', message: 'The Slack install was cancelled.' })
    expect(
      slackReturnFromSearch(
        new URLSearchParams('slack=error&reason=constructor'),
      ),
    ).toEqual({
      kind: 'error',
      message: 'Slack could not be connected. Try again.',
    })
    expect(slackReturnFromSearch(new URLSearchParams(''))).toBeNull()
  })

  it('reads an already-linked workspace and whether its owner was asked', () => {
    expect(
      slackReturnFromSearch(
        new URLSearchParams(
          'slack=error&reason=team_already_linked&notified=1',
        ),
      ),
    ).toEqual({ kind: 'already_linked', notified: true })
    expect(
      slackReturnFromSearch(
        new URLSearchParams(
          'slack=error&reason=team_already_linked&notified=0',
        ),
      ),
    ).toEqual({ kind: 'already_linked', notified: false })
    // Redirects from before `notified` existed: nobody was asked.
    expect(
      slackReturnFromSearch(
        new URLSearchParams('slack=error&reason=team_already_linked'),
      ),
    ).toEqual({ kind: 'already_linked', notified: false })
    expect(alreadyLinkedCopy(true).body).toContain(
      "We've messaged the person who set it up",
    )
    expect(alreadyLinkedCopy(false).body).toContain(
      'Ask a teammate who uses it to invite you',
    )
    for (const notified of [true, false]) {
      expect(alreadyLinkedCopy(notified).headline).toBe(
        'Your team is already here.',
      )
    }
  })
})

function session(
  key: string,
  status: ComputerSession['status'],
  updatedAt: string,
): ComputerSession {
  return {
    key,
    title: key,
    channelId: 'C1',
    threadTs: '1.2',
    ownerSlackUserId: null,
    status,
    updatedAt,
    slackUrl: null,
  }
}

describe('onboarding', () => {
  it('is onboarded once Slack is installed and GitHub connected', () => {
    const slack = { installed: true, teamName: 'Acme' }
    const github = {
      connected: true,
      installations: [{ id: '1', accountLogin: 'acme' }],
    }
    expect(computerIsOnboarded(status())).toBe(false)
    expect(computerIsOnboarded(status({ slack }))).toBe(false)
    expect(computerIsOnboarded(status({ github }))).toBe(false)
    expect(computerIsOnboarded(status({ slack, github }))).toBe(true)
    // Onboarding is about the person's setup, not the computer's mood.
    expect(
      computerIsOnboarded(
        status({ slack, github, computer: { ...computer, state: 'parked' } }),
      ),
    ).toBe(true)
  })
})

describe('live and recent sessions', () => {
  const sessions = [
    session('old-idle', 'idle', '2026-10-11T09:00:00.000Z'),
    session('busy', 'busy', '2026-10-11T10:00:00.000Z'),
    session('ended', 'ended', '2026-10-11T11:00:00.000Z'),
    session('starting', 'starting', '2026-10-11T12:00:00.000Z'),
    session('error', 'error', '2026-10-11T08:00:00.000Z'),
  ]

  it('splits starting and busy from the rest, each newest first', () => {
    const { live, recent } = splitSessions(sessions)
    expect(live.map((s) => s.key)).toEqual(['starting', 'busy'])
    expect(recent.map((s) => s.key)).toEqual(['ended', 'old-idle', 'error'])
    expect(splitSessions([])).toEqual({ live: [], recent: [] })
  })

  it('polls sessions faster while any is live', () => {
    expect(sessionPollInterval(undefined)).toBe(SESSION_POLL_MS)
    // Waiting for the first task: setup moves on by itself, promptly.
    expect(sessionPollInterval([])).toBe(LIVE_SESSION_POLL_MS)
    expect(
      sessionPollInterval(sessions.filter((s) => s.status === 'idle')),
    ).toBe(SESSION_POLL_MS)
    expect(sessionPollInterval(sessions)).toBe(LIVE_SESSION_POLL_MS)
    expect(LIVE_SESSION_POLL_MS).toBe(5_000)
    expect(SESSION_POLL_MS).toBe(15_000)
  })
})

describe('first task', () => {
  it('is the only session, while there is just the one', () => {
    expect(firstSession(undefined)).toBeNull()
    expect(firstSession([])).toBeNull()
    const first = session('first', 'busy', '2026-10-11T10:00:00.000Z')
    const second = session('second', 'idle', '2026-10-11T11:00:00.000Z')
    expect(firstSession([first])).toBe(first)
    expect(firstSession([first, second])).toBeNull()
  })

  it('says where the task is', () => {
    expect(firstTaskCopy('starting').headline).toBe(
      "It's picking up your first task",
    )
    expect(firstTaskCopy('busy').headline).toBe("It's on your first task")
    expect(firstTaskCopy('idle').headline).toBe('It answered your first task')
    expect(firstTaskCopy('ended').headline).toBe('Your first task is done')
    expect(firstTaskCopy('error').headline).toBe(
      'Your first task hit a problem',
    )
  })
})

describe('boot progress', () => {
  const base = {
    computer: null,
    slack: { installed: true },
    github: { connected: true, installations: [] },
    plan: 'free' as const,
  }
  const at = '2026-10-11T10:00:00.000Z'
  const withState = (state: Computer['state'], connected = false) => ({
    ...base,
    computer: { ...computer, state, connected, createdAt: at },
  })

  it('walks from the Slack install to online', () => {
    expect(bootProgress({ ...base, slack: { installed: false } })).toBeNull()
    expect(bootProgress(base)).toEqual({ stage: 0, since: null })
    expect(bootProgress(withState('provisioning'))).toEqual({
      stage: 0,
      since: at,
    })
    expect(bootProgress(withState('ready'))).toEqual({ stage: 1, since: at })
    expect(bootProgress(withState('ready', true))).toEqual({
      stage: 2,
      since: at,
    })
  })

  it('is not booting asleep, failed or going', () => {
    for (const state of ['parked', 'waking', 'failed', 'deleting'] as const) {
      expect(bootProgress(withState(state))).toBeNull()
    }
  })

  it('reads the time taken as a clock', () => {
    const start = new Date(at).getTime()
    expect(elapsedClock(at, start + 7_000)).toBe('0:07')
    expect(elapsedClock(at, start + 161_000)).toBe('2:41')
    expect(elapsedClock(at, start + 3_723_000)).toBe('1:02:03')
    expect(elapsedClock(at, start - 5_000)).toBe('0:00')
    expect(elapsedClock('nope', start)).toBe('')
  })
})

describe('relative time', () => {
  const now = new Date('2026-10-11T12:00:00.000Z').getTime()
  const ago = (ms: number) =>
    relativeTime(new Date(now - ms).toISOString(), now)

  it('reads like a person would say it', () => {
    expect(ago(0)).toBe('just now')
    expect(ago(59_000)).toBe('just now')
    expect(ago(2 * 60_000)).toBe('2 min ago')
    expect(ago(59 * 60_000 + 59_000)).toBe('59 min ago')
    expect(ago(3 * 3_600_000)).toBe('3 hr ago')
    expect(ago(30 * 3_600_000)).toBe('yesterday')
    expect(ago(4 * 86_400_000)).toBe('4 days ago')
    expect(ago(30 * 86_400_000)).not.toMatch(/ago|yesterday/)
  })

  it('treats clock skew as now and ignores bad timestamps', () => {
    expect(ago(-60_000)).toBe('just now')
    expect(relativeTime('not a date', now)).toBe('')
  })
})
