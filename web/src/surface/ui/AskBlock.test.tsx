// @vitest-environment happy-dom
// An ask's controls: an approval that can be remembered or is a plan, a
// question answered in words, a secret typed and sent once.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ask } from '@opencomputer/sdk/computer'
import { SurfaceContext } from '../hooks'
import type { Surface } from '../store'
import { AskBlock } from './AskBlock'

const ask = (over: Partial<Ask>): Ask => ({
  id: 'ask_1',
  sessionId: 'cs_1',
  turnId: 't_1',
  kind: 'approval',
  status: 'open',
  createdAt: '2026-11-26T00:00:00Z',
  closedAt: null,
  closedBy: null,
  answer: null,
  approval: null,
  question: null,
  secret: null,
  ...over,
})

let root: Root
let el: HTMLDivElement
let surface: {
  answer: ReturnType<typeof vi.fn>
  dismissAsk: ReturnType<typeof vi.fn>
  setSecret: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  surface = { answer: vi.fn(), dismissAsk: vi.fn(), setSecret: vi.fn() }
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

function draw(a: Ask) {
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <SurfaceContext.Provider value={surface as unknown as Surface}>
          <AskBlock ask={a} />
        </SurfaceContext.Provider>
      </QueryClientProvider>,
    ),
  )
}

const button = (label: string) => {
  const b = [...el.querySelectorAll('button')].find(
    (x) => x.textContent === label,
  )
  if (!b) throw new Error(`no button ${label}`)
  return b
}

// React tracks an input's value itself; set it the way a person typing does.
function type(input: HTMLInputElement, value: string) {
  const desc = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!
  act(() => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called on `input` here
    Reflect.apply(desc.set!, input, [value])
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('approval', () => {
  it('offers to always allow what the call can remember', () => {
    draw(
      ask({
        approval: { toolName: 'Bash', command: 'ls', alwaysAllows: 'ls' },
      }),
    )
    const always = button('Always allow for this session')
    expect(always.title).toBe('Allows ls without asking again in this session')
    act(() => always.click())
    expect(surface.answer).toHaveBeenCalledWith('cs_1', 'ask_1', {
      decision: 'always',
    })
  })

  it('shows a plan and approves it accepting edits', () => {
    draw(
      ask({
        approval: { toolName: 'ExitPlanMode', input: { plan: 'Step one' } },
      }),
    )
    expect(el.textContent).toContain('Step one')
    expect(el.textContent).not.toContain('Always allow')
    act(() => button('Approve, accept edits').click())
    expect(surface.answer).toHaveBeenCalledWith('cs_1', 'ask_1', {
      decision: 'always',
    })
  })

  it('says a plan approved with edits was so', () => {
    draw(
      ask({
        status: 'answered',
        answer: { decision: 'always' },
        approval: { toolName: 'ExitPlanMode', input: { plan: 'p' } },
      }),
    )
    expect(el.textContent).toContain('Allowed, accepting edits')
  })
})

describe('question', () => {
  it('takes a typed answer', () => {
    draw(
      ask({
        kind: 'question',
        question: {
          questions: [{ id: 'q1', text: 'Which?', options: [{ label: 'A' }] }],
        },
      }),
    )
    // One click answers a single choice, so Send waits for words.
    expect(el.textContent).not.toContain('Send')
    type(el.querySelector('input')!, 'Neither, use C')
    act(() => button('Send').click())
    expect(surface.answer).toHaveBeenCalledWith('cs_1', 'ask_1', {
      answers: [{ questionId: 'q1', choices: [], text: 'Neither, use C' }],
    })
  })
})

describe('secret', () => {
  const secret = ask({
    kind: 'secret',
    secret: { name: 'API_TOKEN', purpose: 'To call the API', file: false },
  })

  it('sends the value once and clears it', async () => {
    let done!: () => void
    surface.setSecret.mockReturnValue(new Promise<void>((r) => (done = r)))
    draw(secret)
    expect(el.textContent).toContain('To call the API')
    const input = el.querySelector('input')!
    expect(input.type).toBe('password')
    type(input, 's3cret')
    await act(() => Promise.resolve(button('Save secret and continue').click()))
    expect(surface.setSecret).toHaveBeenCalledWith('cs_1', 'API_TOKEN', {
      value: 's3cret',
      file: false,
    })
    await vi.waitFor(() => expect(el.textContent).toContain('Saving…'))
    await act(() => Promise.resolve(done()))
    await vi.waitFor(() => expect(el.querySelector('input')).toBeNull())
    expect(el.innerHTML).not.toContain('s3cret')
    expect(el.textContent).toContain('Saved')
  })

  it('says when it could not be saved', async () => {
    surface.setSecret.mockRejectedValue(new Error('no'))
    draw(secret)
    type(el.querySelector('input')!, 'v')
    await act(() => Promise.resolve(button('Save secret and continue').click()))
    await vi.waitFor(() =>
      expect(el.textContent).toContain(
        'Could not save the secret. Please retry.',
      ),
    )
  })
})
