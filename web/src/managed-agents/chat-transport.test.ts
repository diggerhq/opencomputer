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
    )
    expect(runManagedAgent).toHaveBeenCalledTimes(1)
  })
})
