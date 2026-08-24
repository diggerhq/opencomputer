import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Panel, PanelContent } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { completeManagedModelAccess } from './api'
import { MODEL_ACCESS_RETURN_TO_KEY } from './BYOK'

type CallbackState = 'completing' | 'failed'

export default function ModelAccessCallback() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const started = useRef(false)
  const [status, setStatus] = useState<CallbackState>('completing')
  const [message, setMessage] = useState('Completing Codex authorization…')

  useEffect(() => {
    if (started.current) return
    started.current = true
    const providerError = searchParams.get('error')
    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const connectionId = state?.split('.', 1)[0]
    if (providerError || !code || !state || !connectionId) {
      setStatus('failed')
      setMessage(
        providerError
          ? `OpenAI authorization failed: ${providerError}`
          : 'The OAuth callback was incomplete. Return to the project and try again.',
      )
      return
    }

    void completeManagedModelAccess(connectionId, code, state)
      .then(() => {
        const storedReturnTo = sessionStorage.getItem(
          MODEL_ACCESS_RETURN_TO_KEY,
        )
        sessionStorage.removeItem(MODEL_ACCESS_RETURN_TO_KEY)
        const returnTo = storedReturnTo?.startsWith('/projects/')
          ? storedReturnTo
          : '/'
        void navigate(returnTo, { replace: true })
      })
      .catch((error: unknown) => {
        setStatus('failed')
        setMessage(
          error instanceof Error
            ? error.message
            : 'The Codex subscription could not be connected.',
        )
      })
  }, [navigate, searchParams])

  return (
    <div className="mx-auto max-w-xl py-16">
      <Panel>
        <PanelContent className="flex flex-col items-center py-12 text-center">
          {status === 'completing' ? (
            <Loader2 className="text-muted-foreground mb-4 size-8 animate-spin" />
          ) : (
            <CircleAlert className="text-destructive mb-4 size-8" />
          )}
          <h1 className="text-lg font-semibold">
            {status === 'completing'
              ? 'Connecting Codex subscription'
              : 'Codex authorization failed'}
          </h1>
          <p className="text-muted-foreground mt-2 max-w-md text-sm">
            {message}
          </p>
          {status === 'failed' ? (
            <Button asChild className="mt-6" variant="outline">
              <Link to="/">
                <CheckCircle2 /> Return to projects
              </Link>
            </Button>
          ) : null}
        </PanelContent>
      </Panel>
    </div>
  )
}
