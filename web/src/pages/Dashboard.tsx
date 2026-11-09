import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { KeyRound } from 'lucide-react'
import { createAPIKey, getAPIKeys } from '@/api/client'
import { Panel } from '@/components/panel'
import { CopyRow } from '@/components/copy-row'
import { Button } from '@/components/ui/button'

// The legacy home (VITE_MANAGED_AGENTS_EXPERIMENT=0). The sandbox overview and
// quickstart it used to show are gone with the sandbox product (work 097); what
// remains is the organization's API key.
export default function Dashboard() {
  return <GettingStarted />
}

/* ── API key ─────────────────────────────────────────────────── */
export function GettingStarted() {
  const queryClient = useQueryClient()
  const keysQuery = useQuery({
    queryKey: ['api-keys'],
    queryFn: getAPIKeys,
  })
  const autoCreateRef = useRef(false)

  const createMutation = useMutation({
    mutationFn: () => createAPIKey('Default'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['api-keys'] }),
  })

  const keys = keysQuery.data
  const hasKeys = (keys?.length ?? 0) > 0
  const createdKey = createMutation.data?.key ?? null

  // New organizations get one usable key without an extra setup step. Existing
  // secrets remain intentionally unrecoverable; those users get the key manager.
  useEffect(() => {
    if (!keysQuery.isSuccess || autoCreateRef.current) return
    if (!hasKeys && !createdKey && !createMutation.isPending) {
      autoCreateRef.current = true
      createMutation.mutate()
    }
  }, [keysQuery.isSuccess, hasKeys, createdKey, createMutation])

  return (
    <div className="mx-auto max-w-5xl pb-12">
      <Panel className="p-5">
        <div className="grid gap-4 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-start">
          <div className="flex items-center gap-2">
            <KeyRound className="text-muted-foreground size-4" aria-hidden />
            <div>
              <h2 className="text-sm font-semibold">Your API key</h2>
              <p className="text-muted-foreground mt-0.5 text-xs">
                OPENCOMPUTER_API_KEY
              </p>
            </div>
          </div>

          <div className="min-w-0">
            {keysQuery.isLoading || createMutation.isPending ? (
              <p className="text-muted-foreground py-2 text-sm">
                Preparing your API key…
              </p>
            ) : null}

            {createdKey ? (
              <div className="space-y-2">
                <CopyRow value={createdKey} maskable />
                <p className="text-muted-foreground text-xs">
                  Copy it now. For security, it cannot be shown again.
                </p>
              </div>
            ) : null}

            {!createdKey && !createMutation.isPending && hasKeys ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-muted-foreground text-sm">
                  API key ready. Existing secret values cannot be displayed.
                </p>
                <Button size="sm" variant="outline" asChild>
                  <Link to="/api-keys">Manage keys</Link>
                </Button>
              </div>
            ) : null}

            {keysQuery.isError ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-status-error text-sm">
                  Couldn&apos;t load your API keys.
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void keysQuery.refetch()}
                >
                  Retry
                </Button>
              </div>
            ) : null}

            {createMutation.isError ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-status-error text-sm">
                  Couldn&apos;t create your API key.
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => createMutation.mutate()}
                >
                  Retry
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </Panel>
    </div>
  )
}
