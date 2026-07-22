import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, Play } from 'lucide-react'
import { invokeAgent, type Agent } from '@/api/client'
import { notifyError } from '@/lib/errors'
import {
  Panel,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/form'
import { CopyRow } from '@/components/copy-row'
import { ApiHint } from '@/components/api-hint'

const DEFAULT_PAYLOAD = `{
  "task": "Summarize the latest support request"
}`

export function AgentUrlPanel({ agent }: { agent: Agent }) {
  const [payload, setPayload] = useState(DEFAULT_PAYLOAD)
  const [parseError, setParseError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)

  const run = async () => {
    let body: unknown
    try {
      body = JSON.parse(payload)
    } catch {
      setParseError('Enter a valid JSON value.')
      return
    }
    setParseError(null)
    setPending(true)
    try {
      const receipt = await invokeAgent(agent.id, body, crypto.randomUUID())
      // Do not retain the returned client token in component or query state.
      setSessionId(receipt.session.id)
    } catch (error) {
      notifyError("Couldn't invoke the agent.", error)
    } finally {
      setPending(false)
    }
  }

  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>Agent URL</PanelTitle>
          <p className="text-muted-foreground mt-1 text-xs">
            Root invocation requires an OpenComputer API key. Server-side only.
          </p>
        </div>
        <ApiHint
          method="POST"
          path="/"
          docs="https://docs.opencomputer.dev/agent-sessions/agent-urls"
        />
      </PanelHeader>
      <PanelContent className="space-y-4">
        <CopyRow value={agent.invoke_url} />
        <pre className="bg-panel-2 text-muted-foreground overflow-x-auto rounded-md border p-3 font-mono text-[11px] leading-relaxed">{`curl "$AGENT_URL/" \\
  -H "Authorization: Bearer $OPENCOMPUTER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"task":"Summarize the latest support request"}'`}</pre>
        <div className="space-y-2">
          <Textarea
            aria-label="Test JSON payload"
            value={payload}
            onChange={(event) => setPayload(event.target.value)}
            className="min-h-24 font-mono text-xs"
          />
          {parseError ? (
            <p className="text-status-error text-xs font-medium" role="alert">
              {parseError}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void run()}
            >
              <Play className="size-3.5" />
              {pending ? 'Starting…' : 'Run test'}
            </Button>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                to={`/agents/${agent.id}/sessions`}
                className="text-muted-foreground text-xs font-medium underline underline-offset-4"
              >
                View sessions
              </Link>
              {sessionId ? (
                <Link
                  to={`/sessions/${sessionId}`}
                  className="text-foreground inline-flex items-center gap-1 text-xs font-medium underline underline-offset-4"
                >
                  Session {sessionId}
                  <ExternalLink className="size-3" aria-hidden />
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      </PanelContent>
    </Panel>
  )
}
