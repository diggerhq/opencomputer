import { describe, expect, it, vi } from 'vitest'
import type { UIMessage, UIMessageChunk } from 'ai'

const { runManagedAgent, continueManagedAgentSession } = vi.hoisted(() => ({
  runManagedAgent: vi.fn(),
  continueManagedAgentSession: vi.fn(),
}))

vi.mock('./api', () => ({
  runManagedAgent,
  continueManagedAgentSession,
}))

import { ManagedAgentChatTransport } from './chat-transport'

async function readChunks(stream: ReadableStream<UIMessageChunk>) {
  const chunks: UIMessageChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function messages(text: string): UIMessage[] {
  return [
    {
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text }],
    },
  ]
}

describe('ManagedAgentChatTransport', () => {
  it('translates Blue events and continues the assigned session', async () => {
    runManagedAgent.mockImplementation(
      (
        _agentId: string,
        _input: string,
        onEvent: (event: unknown) => void,
        options: { onSession: (sessionId: string) => void },
      ) => {
        options.onSession('session-1')
        onEvent({
          seq: 1,
          type: 'reasoning.delta',
          data: { text: 'Checking' },
        })
        onEvent({
          seq: 2,
          type: 'tool.started',
          data: { callId: 'call-1', tool: 'gmail_search', input: {} },
        })
        onEvent({
          seq: 3,
          type: 'tool.completed',
          data: { callId: 'call-1', tool: 'gmail_search', output: ['email'] },
        })
        onEvent({
          seq: 4,
          type: 'message.delta',
          data: { text: 'Done' },
        })
        onEvent({
          seq: 5,
          type: 'message.completed',
          data: { text: 'Done' },
        })
        return Promise.resolve()
      },
    )
    continueManagedAgentSession.mockResolvedValue({
      sessionId: 'session-1',
      turnId: 'turn-2',
    })
    const assigned: string[] = []
    const transport = new ManagedAgentChatTransport(
      'agent-1',
      undefined,
      (sessionId) => assigned.push(sessionId),
      false,
    )

    const first = await readChunks(
      await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: messages('List my email'),
        abortSignal: undefined,
      }),
    )

    expect(assigned).toEqual(['session-1'])
    expect(first.map((chunk) => chunk.type)).toEqual([
      'start',
      'reasoning-start',
      'reasoning-delta',
      'tool-input-available',
      'tool-output-available',
      'text-start',
      'text-delta',
      'reasoning-end',
      'text-end',
      'finish',
    ])
    expect(first.filter((chunk) => chunk.type === 'text-delta')).toHaveLength(1)

    await readChunks(
      await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: messages('And the next one?'),
        abortSignal: undefined,
      }),
    )

    expect(continueManagedAgentSession).toHaveBeenCalledWith(
      'session-1',
      'And the next one?',
      expect.any(Function),
      undefined,
      [],
    )
    expect(runManagedAgent).toHaveBeenCalledTimes(1)
  })

  it('sends the images of the message, and lets an image go without text', async () => {
    runManagedAgent.mockReset()
    runManagedAgent.mockResolvedValue({ sessionId: 'session-9', turnId: 't' })
    const transport = new ManagedAgentChatTransport(
      'agent-1',
      undefined,
      () => undefined,
      false,
    )
    await readChunks(
      await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [
          {
            id: 'm1',
            role: 'user',
            parts: [
              {
                type: 'file',
                mediaType: 'image/png',
                filename: 'dot.png',
                url: 'data:image/png;base64,iVBORw0KGgo=',
              },
              {
                type: 'file',
                mediaType: 'application/pdf',
                url: 'https://example.com/a.pdf',
              },
            ],
          },
        ],
        abortSignal: undefined,
      }),
    )
    expect(runManagedAgent).toHaveBeenCalledWith(
      'agent-1',
      '',
      expect.any(Function),
      expect.objectContaining({
        attachments: [
          {
            type: 'image',
            mediaType: 'image/png',
            data: 'iVBORw0KGgo=',
            name: 'dot.png',
          },
        ],
      }),
    )
    expect(() =>
      transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: messages('  '),
        abortSignal: undefined,
      }),
    ).toThrow('Enter a message')
  })

  it('paces bursty deltas into a steady trickle without changing the transcript', async () => {
    const reasoning = 'Thinking about the request carefully.'
    const answer = 'Here is the full answer, delivered in two big bursts.'
    runManagedAgent.mockImplementation(
      (
        _agentId: string,
        _input: string,
        onEvent: (event: unknown) => void,
        options: { onSession: (sessionId: string) => void },
      ) => {
        options.onSession('session-2')
        onEvent({ seq: 1, type: 'reasoning.delta', data: { text: reasoning } })
        onEvent({
          seq: 2,
          type: 'tool.started',
          data: { callId: 'call-1', tool: 'search', input: {} },
        })
        onEvent({
          seq: 3,
          type: 'message.delta',
          data: { text: answer.slice(0, 20) },
        })
        onEvent({
          seq: 4,
          type: 'tool.completed',
          data: { callId: 'call-1', tool: 'search', output: 'ok' },
        })
        onEvent({
          seq: 5,
          type: 'message.delta',
          data: { text: answer.slice(20) },
        })
        onEvent({ seq: 6, type: 'message.completed', data: { text: answer } })
        return Promise.resolve()
      },
    )
    const transport = new ManagedAgentChatTransport(
      'agent-1',
      undefined,
      () => undefined,
      { intervalMs: 1, catchUpMs: 8 },
    )

    const chunks = await readChunks(
      await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-2',
        messageId: undefined,
        messages: messages('Go'),
        abortSignal: undefined,
      }),
    )

    const text = (type: 'text-delta' | 'reasoning-delta') =>
      chunks
        .filter((chunk) => chunk.type === type)
        .map((chunk) => (chunk as { delta: string }).delta)
    expect(text('reasoning-delta').join('')).toBe(reasoning)
    expect(text('text-delta').join('')).toBe(answer)
    expect(text('reasoning-delta').length).toBeGreaterThan(1)
    expect(text('text-delta').length).toBeGreaterThan(2)

    const types = chunks.map((chunk) => chunk.type)
    expect(types[0]).toBe('start')
    expect(types.slice(-3)).toEqual(['reasoning-end', 'text-end', 'finish'])
    // The tool call stays where it happened: after all reasoning, and the
    // tool result lands after exactly the first 20 characters of text.
    const toolInput = types.indexOf('tool-input-available')
    const toolOutput = types.indexOf('tool-output-available')
    expect(types.lastIndexOf('reasoning-delta')).toBeLessThan(toolInput)
    expect(toolInput).toBeLessThan(types.indexOf('text-start'))
    expect(
      chunks
        .slice(0, toolOutput)
        .filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => (chunk as { delta: string }).delta)
        .join(''),
    ).toBe(answer.slice(0, 20))
  })
})
