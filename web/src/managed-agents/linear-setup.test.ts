import { describe, expect, it } from 'vitest'
import type { ManagedLinearConnection, ManagedProjectOverview } from './api'
import {
  LINEAR_APP_NAME_RESERVED_MESSAGE,
  LINEAR_RETURN_COPY,
  LINEAR_RETURN_RESULTS,
  checkLinearAppName,
  describeLinearRow,
  describeLinearVerificationError,
  linearAuthorizationHref,
  linearCreateAppHref,
  linearNeedsPolling,
  linearReturnFromSearch,
  linearRowsForProject,
  withoutLinearReturn,
} from './linear-setup'

function connection(
  overrides: Partial<ManagedLinearConnection> = {},
): ManagedLinearConnection {
  return {
    id: 'lc_1',
    projectId: 'prj_1',
    environment: 'development',
    agentId: 'coder',
    name: 'Patch',
    status: 'pending',
    revision: 1,
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  }
}

const project = {
  id: 'prj_1',
  slug: 'linear-agent',
  name: 'linear-agent',
  environments: [
    {
      name: 'development',
      agentId: 'coder',
      activeDeploymentId: 'dep_1',
      updatedAt: '2026-10-02T00:00:00.000Z',
    },
    { name: 'production', updatedAt: '2026-10-02T00:00:00.000Z' },
  ],
  agents: [{ id: 'coder', name: 'Coder' }],
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
} as unknown as ManagedProjectOverview['project']

describe('checkLinearAppName', () => {
  it('refuses names containing "Linear" in any case, with the platform message', () => {
    for (const name of ['Linear bot', 'my-linear-helper', 'LINEAR']) {
      expect(checkLinearAppName(name)).toEqual({
        ok: false,
        message: LINEAR_APP_NAME_RESERVED_MESSAGE,
      })
    }
  })

  it('normalises whitespace and enforces 1 to 64 characters', () => {
    expect(checkLinearAppName('  Patch   the  Fixer ')).toEqual({
      ok: true,
      name: 'Patch the Fixer',
    })
    expect(checkLinearAppName('   ').ok).toBe(false)
    expect(checkLinearAppName('x'.repeat(65)).ok).toBe(false)
    expect(checkLinearAppName('x'.repeat(64)).ok).toBe(true)
  })
})

describe('Linear link guards', () => {
  it('accepts only Linear’s create-app and authorization pages', () => {
    const create = 'https://linear.app/settings/api/applications/new?name=Patch'
    expect(linearCreateAppHref(create)).toBe(create)
    const authorize =
      'https://linear.app/oauth/authorize?client_id=abc&actor=app'
    expect(linearAuthorizationHref(authorize)).toBe(authorize)
    expect(() =>
      linearCreateAppHref('https://evil.example/settings/api/applications/new'),
    ).toThrow()
    expect(() =>
      linearAuthorizationHref(
        'https://linear.app/settings/api/applications/new',
      ),
    ).toThrow()
  })
})

describe('linear return', () => {
  it('reads a known result with its connection and ignores unknown ones', () => {
    expect(
      linearReturnFromSearch(
        'environment=development&linear=denied&connection=lc_1',
      ),
    ).toEqual({ result: 'denied', connectionId: 'lc_1' })
    expect(linearReturnFromSearch('linear=bogus')).toBeUndefined()
    expect(linearReturnFromSearch('environment=production')).toBeUndefined()
  })

  it('removes only its own parameters', () => {
    expect(
      withoutLinearReturn(
        'environment=development&linear=connected&connection=lc_1',
      ),
    ).toBe('?environment=development')
    expect(withoutLinearReturn('linear=connected&connection=lc_1')).toBe('')
  })

  it('has plain copy for every result', () => {
    for (const result of LINEAR_RETURN_RESULTS) {
      expect(LINEAR_RETURN_COPY[result].title).toBeTruthy()
      expect(LINEAR_RETURN_COPY[result].description).toBeTruthy()
    }
    expect(LINEAR_RETURN_COPY.connected.tone).toBe('success')
    expect(LINEAR_RETURN_COPY.denied.description).toContain('admin')
  })

  it('maps each verification error to plain text', () => {
    expect(describeLinearVerificationError(undefined)).toBeUndefined()
    expect(describeLinearVerificationError('authorization_denied')).toContain(
      'declined',
    )
    expect(describeLinearVerificationError('authorization_failed')).toContain(
      'client ID and client secret',
    )
    expect(describeLinearVerificationError('refresh_rejected')).toContain(
      'Authorize it again',
    )
    expect(describeLinearVerificationError('something_new')).toBe(
      'The last authorization did not succeed. Authorize again.',
    )
  })
})

describe('linearRowsForProject', () => {
  it('gives one row per environment, bound to the deployed agent', () => {
    const rows = linearRowsForProject(project, [
      connection(),
      connection({ id: 'lc_old', status: 'disconnected' }),
    ])
    expect(rows.map((row) => row.environment)).toEqual([
      'development',
      'production',
    ])
    expect(rows[0]).toMatchObject({
      agentId: 'coder',
      connection: { id: 'lc_1' },
    })
    expect(rows[1]).toEqual({
      environment: 'production',
      agentId: undefined,
      connection: undefined,
    })
  })
})

describe('describeLinearRow', () => {
  const row = (value?: ManagedLinearConnection) => ({
    environment: 'development' as const,
    agentId: 'coder',
    connection: value,
  })

  it('offers creation, or explains that nothing is deployed', () => {
    expect(describeLinearRow(row()).primary).toEqual({
      action: 'create',
      label: 'Create Linear agent',
    })
    const undeployed = describeLinearRow({ environment: 'production' })
    expect(undeployed.primary).toBeUndefined()
    expect(undeployed.description).toContain('Deploy an agent to production')
  })

  it('follows each health state', () => {
    const view = (health: ManagedLinearConnection['health'], extra = {}) =>
      describeLinearRow(row(connection({ health, ...extra })))

    expect(
      view({ state: 'awaiting_credentials', message: '' }).primary?.action,
    ).toBe('continue')
    expect(
      view({ state: 'awaiting_authorization', message: '' }).primary?.action,
    ).toBe('authorize')
    const waiting = view(
      { state: 'waiting_for_first_delegation', message: '' },
      { status: 'connected' },
    )
    expect(waiting.title).toBe('Waiting for the first delegation')
    expect(waiting.poll).toBe(true)
    const receiving = view(
      {
        state: 'receiving',
        message: '',
        lastEventAt: '2026-10-02T01:00:00.000Z',
      },
      { status: 'connected' },
    )
    expect(receiving.title).toBe('First session received')
    expect(receiving.poll).toBe(false)
    const revoked = view(
      { state: 'revoked', message: '' },
      { status: 'revoked', verificationError: 'refresh_rejected' },
    )
    expect(revoked.tone).toBe('error')
    expect(revoked.primary?.action).toBe('authorize')
    expect(revoked.description).toContain('stopped accepting')
  })

  it('shows a failed authorization on a connection still awaiting it', () => {
    const view = describeLinearRow(
      row(
        connection({
          clientId: 'client',
          verificationError: 'authorization_denied',
          health: { state: 'awaiting_authorization', message: '' },
        }),
      ),
    )
    expect(view.tone).toBe('error')
    expect(view.description).toContain('declined')
  })
})

describe('linearNeedsPolling', () => {
  it('polls only while an authorized connection waits for its first event', () => {
    expect(linearNeedsPolling(undefined)).toBe(false)
    expect(
      linearNeedsPolling([
        connection({ health: { state: 'awaiting_credentials', message: '' } }),
      ]),
    ).toBe(false)
    expect(
      linearNeedsPolling([
        connection({
          status: 'connected',
          health: { state: 'waiting_for_first_delegation', message: '' },
        }),
      ]),
    ).toBe(true)
  })
})
