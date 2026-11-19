import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUp, ChevronRight, Loader2 } from 'lucide-react'
import { ChatTextarea } from '@/components/chat-textarea'
import { Button } from '@/components/ui/button'
import { notifyError } from '@/lib/errors'
import {
  createSession,
  listSessions,
  sessionKeys,
  type SessionSettings,
} from '../computer-sessions-api'
import { SettingsPickers, StatusDot } from './parts'
import { WORKING } from './state'
import { useTriageCount } from './triage'

// No session open: start one, and answer what is waiting on you.
export default function ComputerSessionsHome() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [input, setInput] = useState('')
  const [settings, setSettings] = useState<SessionSettings>({})
  const [computerStarting, setComputerStarting] = useState(false)
  const asks = useTriageCount()
  const working = useQuery({
    queryKey: sessionKeys.list(WORKING),
    queryFn: () => listSessions(WORKING),
    refetchInterval: 5_000,
  })
  const start = useMutation({
    mutationFn: () =>
      createSession(input.trim(), settings, () => setComputerStarting(true)),
    onSettled: () => setComputerStarting(false),
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

        {computerStarting ? (
          <p
            role="status"
            className="text-muted-foreground mt-3 inline-flex items-center gap-2 text-sm"
          >
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Starting your computer. The first time takes a minute or two.
          </p>
        ) : null}

        {asks ? (
          <Link
            to="/computer/triage"
            className="bg-card hover:bg-muted/60 mt-10 flex items-center gap-2 rounded-lg border border-amber-500/40 px-3 py-2.5 text-sm transition-colors"
          >
            <StatusDot status="waiting" />
            <span className="flex-1">
              {asks} {asks === 1 ? 'ask needs' : 'asks need'} you
            </span>
            <span className="text-muted-foreground text-xs">Open triage</span>
            <ChevronRight
              className="text-muted-foreground size-3.5"
              aria-hidden
            />
          </Link>
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
