import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUp, Loader2 } from 'lucide-react'
import { ChatTextarea } from '@/components/chat-textarea'
import { Button } from '@/components/ui/button'
import { notifyError } from '@/lib/errors'
import {
  createSession,
  listSessions,
  sessionKeys,
  type SessionSettings,
} from '../computer-sessions-api'
import { AskCard, SettingsPickers } from './parts'
import { NEEDS_YOU, WORKING } from './state'

// No session open: start one, and answer what is waiting on you.
export default function ComputerSessionsHome() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [input, setInput] = useState('')
  const [settings, setSettings] = useState<SessionSettings>({})
  const needs = useQuery({
    queryKey: sessionKeys.list(NEEDS_YOU),
    queryFn: () => listSessions(NEEDS_YOU),
    refetchInterval: 5_000,
  })
  const working = useQuery({
    queryKey: sessionKeys.list(WORKING),
    queryFn: () => listSessions(WORKING),
    refetchInterval: 5_000,
  })
  const start = useMutation({
    mutationFn: () => createSession(input.trim(), settings),
    onSuccess: (session) => {
      setInput('')
      void qc.invalidateQueries({ queryKey: sessionKeys.all })
      void navigate(`/computer/sessions/${session.id}`)
    },
    onError: (e) => notifyError('Could not start the session', e),
  })
  const send = () => {
    if (input.trim() && !start.isPending) start.mutate()
  }

  const waiting = (needs.data?.sessions ?? []).flatMap((s) =>
    s.asks.filter((a) => a.status === 'open').map((ask) => ({ s, ask })),
  )
  const busy = working.data?.sessions.length ?? 0

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-6 pt-[18vh] pb-10">
        <h1 className="mb-6 text-center text-2xl font-semibold tracking-tight">
          What should Computer work on?
        </h1>
        <div className="bg-card focus-within:border-ring/60 rounded-xl border shadow-sm transition-colors">
          <ChatTextarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onSend={send}
            placeholder="Describe a task, ask a question, or paste a link"
            className="min-h-20 resize-none border-0 bg-transparent px-4 pt-3.5 text-[15px] shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <SettingsPickers value={settings} onChange={setSettings} />
            <Button
              size="icon"
              className="rounded-full"
              aria-label="Start session"
              disabled={!input.trim() || start.isPending}
              onClick={send}
            >
              {start.isPending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <ArrowUp aria-hidden />
              )}
            </Button>
          </div>
        </div>

        {waiting.length ? (
          <section className="mt-10 space-y-2">
            <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Needs you
            </h2>
            {waiting.map(({ s, ask }) => (
              <AskCard key={ask.id} ask={ask} session={s} showSession />
            ))}
          </section>
        ) : null}
        <div className="flex-1" />
        {busy ? (
          <p className="text-muted-foreground mt-10 text-center text-xs">
            {busy} {busy === 1 ? 'session is' : 'sessions are'} working
          </p>
        ) : null}
      </div>
    </div>
  )
}
