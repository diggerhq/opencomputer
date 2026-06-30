import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plug, Unplug, ExternalLink } from 'lucide-react'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  getDeployApp,
  getDeploymentSource,
  linkDeploymentSource,
  unlinkDeploymentSource,
} from '@/api/client'
import { Panel, PanelContent } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/form'

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
  })
  const { data: source, isLoading: srcLoading } = useQuery({
    queryKey: ['agent-deploy-source', agentId],
    queryFn: async () => {
      try {
        return (await getDeploymentSource(agentId)).source
      } catch {
        return null // 404 = not linked
      }
    },
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
        ) : !app?.installed ? (
          <Button size="sm" disabled={!app?.install_url} asChild>
            <a href={app?.install_url ?? '#'} target="_blank" rel="noreferrer">
              <Plug className="size-4" />
              Connect GitHub
            </a>
          </Button>
        ) : (
          <div className="space-y-3" ref={pickerRef}>
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
                disabled={link.isPending || !repo}
                onClick={() => link.mutate()}
              >
                {link.isPending
                  ? source
                    ? 'Updating…'
                    : 'Connecting…'
                  : source
                    ? 'Update'
                    : 'Connect'}
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
          </div>
        )}
      </PanelContent>
    </Panel>
  )
}
