import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Unplug, ExternalLink } from 'lucide-react'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  ApiError,
  getDeployApp,
  getDeploymentSource,
  linkDeploymentSource,
  unlinkDeploymentSource,
} from '@/api/client'
import { Panel, PanelContent } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/form'

// GitHub mark (lucide's brand `Github` icon is deprecated/unexported — inline the SVG).
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

function statusTone(status?: string): string {
  if (status === 'active') return 'text-green-600 dark:text-green-500'
  if (
    status === 'path_missing' ||
    status === 'ref_missing' ||
    status === 'app_suspended' ||
    status === 'error'
  )
    return 'text-red-600 dark:text-red-500'
  return 'text-amber-600 dark:text-amber-500'
}

/**
 * Source card (Overview right rail) — minimal. Connect a GitHub repo as the agent's source:
 * not installed → a single Connect (install) button; installed → an editable repo / directory /
 * branch picker (pre-filled when already linked) + a quiet Disconnect + an "Add more repos" link.
 * Pushes to the branch create new revisions; re-applying the picker (Update) pulls HEAD into one.
 * No card title, no nested borders — just the lightweight controls that matter.
 */
export function AgentDeploySource({
  agentId,
  autoFocusPicker = false,
}: {
  agentId: string
  autoFocusPicker?: boolean
}) {
  const queryClient = useQueryClient()
  const pickerRef = useRef<HTMLDivElement>(null)
  const [repo, setRepo] = useState('')
  const [path, setPath] = useState('')
  const [branch, setBranch] = useState('main')

  const { data: app, isLoading: appLoading } = useQuery({
    queryKey: ['deploy-app'],
    queryFn: getDeployApp,
    // The App is installed in another tab; refetch whenever the user returns so the
    // card flips to the repo picker immediately (staleTime would otherwise hide it).
    refetchOnWindowFocus: 'always',
  })
  const {
    data: source,
    isLoading: srcLoading,
    isError: srcError,
    refetch: refetchSource,
  } = useQuery({
    queryKey: ['agent-deploy-source', agentId],
    queryFn: async () => {
      try {
        return (await getDeploymentSource(agentId)).source
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null // not linked
        throw e // a real failure (500/auth/proxy) must not masquerade as "not connected"
      }
    },
    refetchOnWindowFocus: 'always',
  })

  // Pre-fill the picker from the current link once, so "connected" is an editable picker.
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (source && !hydratedRef.current) {
      hydratedRef.current = true
      setRepo(source.full_name ?? '')
      setPath(source.path ?? '')
      setBranch(source.production_ref || 'main')
    }
  }, [source])

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ['agent-deploy-source', agentId],
    })
    void queryClient.invalidateQueries({
      queryKey: ['agent-revisions', agentId],
    })
    void queryClient.invalidateQueries({ queryKey: ['agent', agentId] })
  }

  const link = useMutation({
    mutationFn: () =>
      linkDeploymentSource(agentId, {
        repo,
        path: path.trim(),
        production_ref: branch.trim() || 'main',
      }),
    onSuccess: (r) => {
      invalidate()
      if (r.deploy_error) {
        notifyError(
          `Connected, but the first revision couldn't be created (${r.deploy_error.message}).`,
          new Error(r.deploy_error.type),
        )
      } else {
        notifySuccess(
          source
            ? 'Updated — creating a revision from the latest commit.'
            : 'Connected — creating the first revision.',
        )
      }
    },
    onError: (e) => notifyError("Couldn't connect the repo.", e),
  })
  const unlink = useMutation({
    mutationFn: () => unlinkDeploymentSource(agentId),
    onSuccess: () => {
      invalidate()
      hydratedRef.current = false
      setRepo('')
      setPath('')
      setBranch('main')
      notifySuccess('Disconnected. Existing revisions are unchanged.')
    },
    onError: (e) => notifyError("Couldn't disconnect.", e),
  })

  const pickRepo = (fullName: string) => {
    setRepo(fullName)
    const r = app?.repositories.find((x) => x.full_name === fullName)
    if (r?.default_branch) setBranch(r.default_branch)
  }

  // Arrived via a setup CTA (?connect=github) → scroll the picker in + focus it (once).
  const focusedRef = useRef(false)
  useEffect(() => {
    if (
      autoFocusPicker &&
      !focusedRef.current &&
      app?.installed &&
      pickerRef.current
    ) {
      focusedRef.current = true
      pickerRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
      pickerRef.current
        .querySelector<HTMLElement>('button, [role="combobox"], input, select')
        ?.focus()
    }
  }, [autoFocusPicker, app?.installed])

  // Repo options — include the linked repo even if it's not in the installable list.
  const repoOptions = (app?.repositories ?? []).map((r) => ({
    value: r.full_name,
    label: r.full_name,
  }))
  if (
    source?.full_name &&
    !repoOptions.some((o) => o.value === source.full_name)
  ) {
    repoOptions.unshift({ value: source.full_name, label: source.full_name })
  }

  return (
    <Panel className="overflow-hidden">
      <PanelContent className="space-y-3">
        {srcLoading || appLoading ? (
          <p className="text-muted-foreground text-xs">Loading…</p>
        ) : srcError ? (
          <div className="space-y-2">
            <p className="text-xs text-red-600 dark:text-red-500">
              Couldn’t load the repo connection.
            </p>
            <Button size="sm" variant="outline" onClick={() => void refetchSource()}>
              Retry
            </Button>
          </div>
        ) : !app?.installed ? (
          <div className="space-y-3">
            <Button size="sm" variant="outline" disabled={!app?.install_url} asChild>
              <a href={app?.install_url ?? '#'} target="_blank" rel="noreferrer">
                <GithubMark className="size-4" />
                Connect repository
              </a>
            </Button>
            <p className="text-muted-foreground text-xs">
              Or deploy from the CLI:{' '}
              <code className="font-mono">oc agent deploy</code>
            </p>
          </div>
        ) : (
          <div className="space-y-3" ref={pickerRef}>
            {!source ? (
              <p className="text-xs">
                <span className="font-medium text-green-600 dark:text-green-500">
                  GitHub connected.
                </span>{' '}
                <span className="text-muted-foreground">
                  Last step — pick a repo to deploy from.
                </span>
              </p>
            ) : null}
            <Select
              value={repo}
              onValueChange={pickRepo}
              placeholder={
                repoOptions.length ? 'Select a repo' : 'No repos available'
              }
              disabled={repoOptions.length === 0}
              options={repoOptions}
            />
            <div className="flex gap-2">
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="directory"
              />
              <Input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                className="max-w-28"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={link.isPending || !repo}
                onClick={() => link.mutate()}
              >
                {link.isPending
                  ? source
                    ? 'Updating…'
                    : 'Deploying…'
                  : source
                    ? 'Update'
                    : 'Deploy'}
              </Button>
              {source ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground"
                  disabled={unlink.isPending}
                  onClick={() => unlink.mutate()}
                >
                  <Unplug className="size-4" />
                  Disconnect
                </Button>
              ) : null}
              {source?.active_deployed_sha ? (
                <span
                  className={`ml-auto font-mono text-xs ${statusTone(source.status)}`}
                  title={source.status}
                >
                  ● @{source.active_deployed_sha.slice(0, 7)}
                </span>
              ) : null}
            </div>
            {app.configure_url ? (
              <a
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
                href={app.configure_url}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="size-3" />
                Add more repos
              </a>
            ) : null}
            <p className="text-muted-foreground text-xs">
              Pushes to{' '}
              <code className="font-mono">
                {branch.trim() || 'the production branch'}
              </code>{' '}
              update the prompt + skills. Or from the CLI:{' '}
              <code className="font-mono">oc agent deploy</code>
            </p>
          </div>
        )}
      </PanelContent>
    </Panel>
  )
}
