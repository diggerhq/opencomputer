import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import {
  authorizeManagedLinearConnection,
  collectManagedAgentEventPages,
  createManagedLinearConnection,
  disconnectManagedLinearConnection,
  displayManagedAgentName,
  listManagedLinearConnections,
  setManagedLinearCredentials,
  fetchManagedAgentWorkspaceObject,
  latestManagedAgentModelRoute,
  managedAgentModelRoute,
  managedAgentRenderDebug,
} from './api'

afterEach(() => vi.restoreAllMocks())

describe('fetchManagedAgentWorkspaceObject', () => {
  it('fetches the signed object without platform credentials or redirects', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3])))

    const response = await fetchManagedAgentWorkspaceObject(
      'https://objects.example.test/artifact?signature=test',
    )

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    )
    expect(fetch).toHaveBeenCalledWith(
      'https://objects.example.test/artifact?signature=test',
      expect.objectContaining({ credentials: 'omit', redirect: 'error' }),
    )
  })
})

describe('collectManagedAgentEventPages', () => {
  it('follows event cursors until the API returns an empty page', async () => {
    const cursors: number[] = []
    const pages = new Map([
      [0, [{ seq: 1 }, { seq: 500 }]],
      [500, [{ seq: 501 }]],
      [501, []],
    ])

    const events = await collectManagedAgentEventPages((after) => {
      cursors.push(after)
      return Promise.resolve(
        (pages.get(after) ?? []).map(({ seq }) => ({
          seq,
          type: 'message.delta',
          data: { text: String(seq) },
        })),
      )
    })

    expect(cursors).toEqual([0, 500, 501])
    expect(events.map(({ seq }) => seq)).toEqual([1, 500, 501])
  })
})

describe('displayManagedAgentName', () => {
  it('hides UUID-shaped legacy names without hiding readable stable names', () => {
    expect(
      displayManagedAgentName({
        id: '8d25ba55-d9de-4345-bedd-92ac5a3f1485',
        name: '8d25ba55-d9de-4345-bedd-92ac5a3f1485',
      }),
    ).toBe('Untitled agent')
    expect(
      displayManagedAgentName({ id: 'email-triage', name: 'email-triage' }),
    ).toBe('email-triage')
    expect(
      displayManagedAgentName({ id: 'stable-id', name: 'Gentle Falcon' }),
    ).toBe('Gentle Falcon')
  })
})

describe('managedAgentRenderDebug', () => {
  it('parses reactive render snapshots and ignores unrelated events', () => {
    const event = {
      id: 'event-1',
      seq: 1,
      timestamp: '2026-08-10T00:00:00.000Z',
      sessionId: 'session-1',
      turnId: 'turn-1',
      type: 'agent.rendered',
      data: {
        renderId: 'render-1',
        responseId: 'response-1',
        providerTurn: 2,
        renderedAt: '2026-08-10T00:00:00.000Z',
        stateVersion: 3,
        instructions: 'Help the user.',
        instructionsHash: 'sha256:prompt',
        input: { source: 'user', text: 'Hello' },
        tools: [{ name: 'search', description: 'Search documentation' }],
        enabledTools: ['search'],
        requiredConnections: [],
        enabledMcpServers: [],
        enabledSubagents: [],
        model: { provider: 'openrouter', model: 'openai/gpt-5.2' },
      },
    }

    expect(managedAgentRenderDebug(event)).toMatchObject({
      renderId: 'render-1',
      instructions: 'Help the user.',
      enabledTools: ['search'],
    })
    expect(
      managedAgentRenderDebug({ ...event, type: 'runtime.log' }),
    ).toBeUndefined()
  })
})

describe('managedAgentModelRoute', () => {
  it('parses Codex BYOK route attribution', () => {
    const event = {
      id: 'event-2',
      seq: 2,
      timestamp: '2026-08-24T00:00:00.000Z',
      sessionId: 'session-1',
      turnId: 'turn-1',
      type: 'model.route_resolved',
      data: {
        requested: { provider: 'openai', model: 'gpt-5.6-sol' },
        effective: { provider: 'openai', model: 'gpt-5.6-sol' },
        runtime: 'codex',
        access: {
          type: 'external_subscription',
          connectionId: 'mac_1',
          connectionKind: 'codex_subscription',
        },
        openComputerModelChargeUsd: 0,
      },
    }

    expect(managedAgentModelRoute(event)).toMatchObject({
      access: {
        type: 'external_subscription',
        connectionKind: 'codex_subscription',
      },
      openComputerModelChargeUsd: 0,
    })
    expect(
      managedAgentModelRoute({ ...event, type: 'agent.rendered' }),
    ).toBeUndefined()
  })

  it('returns the most recent route for latestManagedAgentModelRoute', () => {
    const routeEvent = (seq: number, model: string) => ({
      id: `event-${seq}`,
      seq,
      timestamp: '2026-08-24T00:00:00.000Z',
      sessionId: 'session-1',
      type: 'model.route_resolved',
      data: {
        requested: { provider: 'openrouter', model },
        effective: { provider: 'openrouter', model },
        runtime: 'workerd',
        access: { type: 'managed' },
        openComputerModelChargeUsd: null,
      },
    })
    const other = {
      id: 'event-3',
      seq: 3,
      timestamp: '2026-08-24T00:00:00.000Z',
      sessionId: 'session-1',
      type: 'runtime.log',
      data: { message: 'hi' },
    }

    expect(
      latestManagedAgentModelRoute([
        routeEvent(1, 'anthropic/claude-sonnet-4.5'),
        other,
        routeEvent(4, 'anthropic/claude-sonnet-4.6'),
      ])?.effective?.model,
    ).toBe('anthropic/claude-sonnet-4.6')
    expect(latestManagedAgentModelRoute([other])).toBeUndefined()
    expect(latestManagedAgentModelRoute([])).toBeUndefined()
  })
})

describe('Linear connections', () => {
  const connection = {
    id: 'lc_1',
    projectId: 'prj_1',
    environment: 'development',
    agentId: 'coder',
    name: 'Patch',
    status: 'pending',
    webhookUrl: 'https://hooks.example.test/v1/webhooks/linear/lc_1/token',
    createAppUrl: 'https://linear.app/settings/api/applications/new?name=Patch',
    health: {
      state: 'awaiting_credentials',
      message: 'Create the app in Linear, then paste its credentials.',
    },
    revision: 1,
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  it('lists a project’s connections, optionally for one environment', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(json({ connections: [connection] })),
      )

    expect(await listManagedLinearConnections('prj 1')).toEqual([connection])
    await listManagedLinearConnections('prj_1', 'production')

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/dashboard/managed-agents/projects/prj%201/linear/connections',
      '/api/dashboard/managed-agents/projects/prj_1/linear/connections?environment=production',
    ])
  })

  it('creates a connection for an agent and environment', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        {
          connectionId: 'lc_1',
          webhookUrl: connection.webhookUrl,
          createAppUrl: connection.createAppUrl,
          connection,
        },
        201,
      ),
    )

    const created = await createManagedLinearConnection({
      projectId: 'prj_1',
      environment: 'development',
      agentId: 'coder',
      name: 'Patch',
    })

    expect(created.createAppUrl).toBe(connection.createAppUrl)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(
      '/api/dashboard/managed-agents/projects/prj_1/linear/connections',
    )
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      name: 'Patch',
      environment: 'development',
      agentId: 'coder',
    })
  })

  it('sends the credentials once and keeps only the redacted connection', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        connection: {
          ...connection,
          clientId: 'client-id',
          // Never sent by the platform; the schema drops unknown fields anyway.
          clientSecret: 'client-secret',
          health: { state: 'awaiting_authorization', message: 'Authorize.' },
        },
      }),
    )

    const updated = await setManagedLinearCredentials('lc_1', {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      signingSecret: 'signing-secret',
    })

    expect(updated.health?.state).toBe('awaiting_authorization')
    expect(JSON.stringify(updated)).not.toContain('client-secret')
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(
      '/api/dashboard/managed-agents/linear/connections/lc_1/credentials',
    )
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      signingSecret: 'signing-secret',
    })
  })

  it('asks for an authorization link and disconnects', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        json({
          authorizeUrl: 'https://linear.app/oauth/authorize?client_id=c',
          expiresAt: '2026-10-02T00:10:00.000Z',
        }),
      )
      .mockResolvedValueOnce(
        json({
          connection: { ...connection, status: 'disconnected' },
          revoked: true,
        }),
      )

    expect(
      (await authorizeManagedLinearConnection('lc_1')).authorizeUrl,
    ).toContain('linear.app/oauth/authorize')
    expect((await disconnectManagedLinearConnection('lc_1')).revoked).toBe(true)
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [
        '/api/dashboard/managed-agents/linear/connections/lc_1/authorize',
        'POST',
      ],
      ['/api/dashboard/managed-agents/linear/connections/lc_1', 'DELETE'],
    ])
  })

  it('surfaces the platform’s error code and message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        {
          error: {
            code: 'linear_app_name_reserved',
            message:
              'Linear does not allow app names that contain "Linear". Choose another name.',
          },
        },
        400,
      ),
    )

    const failure = await createManagedLinearConnection({
      projectId: 'prj_1',
      environment: 'development',
      agentId: 'coder',
      name: 'Linear helper',
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({
      status: 400,
      type: 'linear_app_name_reserved',
      message:
        'Linear does not allow app names that contain "Linear". Choose another name.',
    })
  })
})
