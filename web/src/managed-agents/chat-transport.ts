import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import {
  continueManagedAgentSession,
  runManagedAgent,
  type ManagedAgentEvent,
} from './api'

function eventText(event: ManagedAgentEvent) {
  return typeof event.data.text === 'string' ? event.data.text : ''
}

function eventError(event: ManagedAgentEvent) {
  return typeof event.data.message === 'string'
    ? event.data.message
    : typeof event.data.reason === 'string'
      ? event.data.reason
      : 'The agent could not complete this request.'
}

function lastUserText(messages: UIMessage[]) {
  const message = [...messages]
    .reverse()
    .find((candidate) => candidate.role === 'user')
  return (
    message?.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('') ?? ''
  )
}

export class ManagedAgentChatTransport implements ChatTransport<UIMessage> {
  private sessionId?: string

  constructor(
    private readonly agentId: string,
    sessionId: string | undefined,
    private readonly onSession: (sessionId: string) => void,
  ) {
    this.sessionId = sessionId
  }

  async sendMessages({
    messages,
    abortSignal,
  }: Parameters<ChatTransport<UIMessage>['sendMessages']>[0]) {
    const input = lastUserText(messages).trim()
    if (!input) throw new Error('Enter a message before sending.')

    const messageId = crypto.randomUUID()
    const textId = `${messageId}:text`
    const reasoningId = `${messageId}:reasoning`

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        let closed = false
        let textStarted = false
        let reasoningStarted = false
        const startedTools = new Set<string>()

        const enqueue = (chunk: UIMessageChunk) => {
          if (!closed && !abortSignal?.aborted) controller.enqueue(chunk)
        }
        const finishParts = () => {
          if (reasoningStarted)
            enqueue({ type: 'reasoning-end', id: reasoningId })
          if (textStarted) enqueue({ type: 'text-end', id: textId })
        }
        const onEvent = (event: ManagedAgentEvent) => {
          if (event.type === 'reasoning.delta') {
            if (!reasoningStarted) {
              enqueue({ type: 'reasoning-start', id: reasoningId })
              reasoningStarted = true
            }
            enqueue({
              type: 'reasoning-delta',
              id: reasoningId,
              delta: eventText(event),
            })
            return
          }
          if (event.type === 'message.delta') {
            if (!textStarted) {
              enqueue({ type: 'text-start', id: textId })
              textStarted = true
            }
            enqueue({ type: 'text-delta', id: textId, delta: eventText(event) })
            return
          }
          if (event.type === 'message.completed' && !textStarted) {
            enqueue({ type: 'text-start', id: textId })
            textStarted = true
            enqueue({ type: 'text-delta', id: textId, delta: eventText(event) })
            return
          }
          if (!event.type.startsWith('tool.')) return

          const toolCallId =
            typeof event.data.callId === 'string'
              ? event.data.callId
              : `${event.type}:${event.seq}`
          const toolName =
            typeof event.data.tool === 'string' ? event.data.tool : 'tool'
          if (!startedTools.has(toolCallId)) {
            enqueue({
              type: 'tool-input-available',
              toolCallId,
              toolName,
              title:
                typeof event.data.title === 'string'
                  ? event.data.title
                  : undefined,
              input: event.data.input ?? {},
              dynamic: true,
            })
            startedTools.add(toolCallId)
          }
          if (event.type === 'tool.completed') {
            enqueue({
              type: 'tool-output-available',
              toolCallId,
              output: event.data.output ?? null,
              dynamic: true,
            })
          } else if (event.type === 'tool.failed') {
            enqueue({
              type: 'tool-output-error',
              toolCallId,
              errorText: eventError(event),
              dynamic: true,
            })
          }
        }

        enqueue({ type: 'start', messageId })
        void (
          this.sessionId
            ? continueManagedAgentSession(
                this.sessionId,
                input,
                onEvent,
                abortSignal,
              )
            : runManagedAgent(this.agentId, input, onEvent, {
                signal: abortSignal,
                onSession: (sessionId) => {
                  this.sessionId = sessionId
                  this.onSession(sessionId)
                },
              })
        )
          .then(() => {
            finishParts()
            enqueue({ type: 'finish', finishReason: 'stop' })
          })
          .catch((error: unknown) => {
            if (abortSignal?.aborted) enqueue({ type: 'abort' })
            else
              enqueue({
                type: 'error',
                errorText:
                  error instanceof Error ? error.message : String(error),
              })
          })
          .finally(() => {
            closed = true
            controller.close()
          })
      },
    })
  }

  async reconnectToStream() {
    return null
  }
}
