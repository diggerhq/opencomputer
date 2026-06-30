import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitBranch, Plug, Unplug, ExternalLink, Rocket } from 'lucide-react'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  getDeployApp,
  getDeploymentSource,
  linkDeploymentSource,
  unlinkDeploymentSource,
  deployFromGithub,
} from '@/api/client'
import {
  Panel,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/form'

// Human label + tone for each link status (matches agent_deployment_sources.status).
const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'err' }> = {
  active: { label: 'Connected', tone: 'ok' },
  path_missing: { label: 'Directory not found', tone: 'err' },
  ref_missing: { label: 'Production branch deleted', tone: 'err' },
  auth_required: { label: 'App lost access to this repo', tone: 'warn' },
  repo_not_selected: { label: 'Repo not selected in the App', tone: 'warn' },
  app_suspended: { label: 'GitHub App suspended', tone: 'err' },
  error: { label: 'Error', tone: 'err' },
}
const TONE: Record<'ok' | 'warn' | 'err', string> = {
  ok: 'text-green-600 dark:text-green-500',
  warn: 'text-amber-600 dark:text-amber-500',
  err: 'text-red-600 dark:text-red-500',
}

/**
 * Source panel (admin) — connect a GitHub repo as the agent's source: install the OpenComputer
 * GitHub App, pick a repo it can reach, choose a directory + branch. Pushes then create new
 * revisions; "Update" pulls the production-branch HEAD into a revision on demand. Vercel/Fly-style:
 * not-installed → install; installed → pick from the App's repos (+ "Configure" to add more);
 * connected → status + Update + Disconnect. The OC App here is operator config, distinct from BYO
 * product apps. (User-facing language is revisions/source; "deployment" stays internal.)
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

  // The org's OC-App install-state + pickable repos (admin), and this agent's current link.
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
        return null // 404 = not linked (also tolerates a transient blip)
      }
    },
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ['agent-deploy-source', agentId],
    })
    void queryClient.invalidateQueries({ queryKey: ['agent-deploys', agentId] })
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
          `Repo connected, but the first revision couldn't be created (${r.deploy_error.message}).`,
          new Error(r.deploy_error.type),
        )
      } else {
        notifySuccess('Repo connected — creating the first revision.')
      }
    },
    onError: (e) => notifyError("Couldn't connect the repo.", e),
  })
  const unlink = useMutation({
    mutationFn: () => unlinkDeploymentSource(agentId),
    onSuccess: () => {
      invalidate()
      notifySuccess('Repo disconnected. Existing revisions are unchanged.')
    },
    onError: (e) => notifyError("Couldn't disconnect the repo.", e),
  })
  const deployNow = useMutation({
    mutationFn: () => deployFromGithub(agentId),
    onSuccess: () => {
      invalidate()
      notifySuccess(
        'Updating — creating a revision from the production branch.',
      )
    },
    onError: (e) => notifyError("Couldn't update from the repo.", e),
  })

  const pickRepo = (fullName: string) => {
    setRepo(fullName)
    const r = app?.repositories.find((x) => x.full_name === fullName)
    if (r?.default_branch) setBranch(r.default_branch)
  }

  const st = source
    ? (STATUS[source.status] ?? { label: source.status, tone: 'warn' as const })
    : null

  // Arrived via a setup CTA (?connect=github) → scroll the repo picker into view
  // and focus it. Only meaningful when installed-but-unlinked (the picker is
  // rendered then). Latched so it fires once.
  const focusedRef = useRef(false)
  useEffect(() => {
    if (
      autoFocusPicker &&
      !focusedRef.current &&
      app?.installed &&
      !source &&
      pickerRef.current
    ) {
      focusedRef.current = true
      pickerRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
      pickerRef.current
        .querySelector<HTMLElement>('button, [role="combobox"], input, select')
        ?.focus()
    }
  }, [autoFocusPicker, app?.installed, source])

  return (
    <Panel className="overflow-hidden">
      <PanelHeader>
        <PanelTitle>Source</PanelTitle>
        <span className="text-muted-foreground text-xs">
          Connect a GitHub repo — pushes create new revisions.
        </span>
      </PanelHeader>
      <PanelContent className="space-y-4">
        {srcLoading || appLoading ? (
          <p className="text-muted-foreground text-xs">Loading…</p>
        ) : source && st ? (
          /* ── Connected ── */
          <div className="space-y-3">
            <div className="space-y-2 rounded-md border px-4 py-3">
              <div className="space-y-1">
                <div className="text-foreground flex items-center gap-2 font-mono text-[13px]">
                  <span>
                    {source.full_name ?? '(repo)'}
                    {source.path ? (
                      <span className="text-muted-foreground">
                        /{source.path}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground inline-flex items-center gap-1">
                    <GitBranch className="size-3.5" />
                    {source.production_ref}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className={TONE[st.tone]}>● {st.label}</span>
                  {source.active_deployed_sha ? (
                    <span className="text-muted-foreground font-mono">
                      revision @ {source.active_deployed_sha.slice(0, 7)}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {st.tone === 'ok' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground"
                    disabled={deployNow.isPending}
                    onClick={() => deployNow.mutate()}
                    title="Update: create a revision from the production branch's current HEAD"
                  >
                    <Rocket className="size-4" />
                    {deployNow.isPending ? 'Updating…' : 'Update'}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground"
                  disabled={unlink.isPending}
                  onClick={() => unlink.mutate()}
                >
                  <Unplug className="size-4" />
                  {unlink.isPending ? 'Disconnecting…' : 'Disconnect'}
                </Button>
              </div>
            </div>
            {st.tone === 'ok' ? (
              <p className="text-muted-foreground text-xs">
                Pushes to{' '}
                <span className="font-mono">{source.production_ref}</span>{' '}
                create + activate a revision; other branches create a staged
                revision.
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                {(source.status === 'auth_required' ||
                  source.status === 'repo_not_selected') &&
                app?.configure_url ? (
                  <>
                    Re-select this repo in the{' '}
                    <a
                      className="underline"
                      href={app.configure_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      GitHub App
                    </a>
                    , then push again.
                  </>
                ) : (
                  'Fix the issue in the repo, then push again.'
                )}
              </p>
            )}
          </div>
        ) : !app?.installed ? (
          /* ── App not installed ── */
          <div className="flex items-center justify-between gap-6 rounded-md border border-dashed px-5 py-6">
            <div className="space-y-1.5">
              <div className="text-foreground text-sm font-medium">
                Connect a GitHub repository
              </div>
              <p className="text-muted-foreground text-xs">
                Install the OpenComputer GitHub App on the repos that hold your
                agent directories.
              </p>
            </div>
            <Button size="sm" disabled={!app?.install_url} asChild>
              <a
                href={app?.install_url ?? '#'}
                target="_blank"
                rel="noreferrer"
              >
                <Plug className="size-4" />
                Install GitHub App
              </a>
            </Button>
          </div>
        ) : (
          /* ── Installed → pick a repo ── */
          <div className="space-y-4" ref={pickerRef}>
            <div className="grid gap-3">
              <Field label="Repository">
                <Select
                  value={repo}
                  onValueChange={pickRepo}
                  placeholder={
                    app.repositories.length
                      ? 'Select a repo'
                      : 'No repos available'
                  }
                  disabled={app.repositories.length === 0}
                  options={app.repositories.map((r) => ({
                    value: r.full_name,
                    label: r.full_name,
                  }))}
                />
              </Field>
              <Field label="Directory">
                <Input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="agents/issue-fixer"
                />
              </Field>
              <Field label="Branch">
                <Input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="main"
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {app.configure_url ? (
                <a
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline"
                  href={app.configure_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="size-3.5" />
                  Don&apos;t see your repo? Configure the App
                </a>
              ) : null}
              <Button
                size="sm"
                className="ml-auto"
                disabled={link.isPending || !repo}
                onClick={() => link.mutate()}
              >
                <Plug className="size-4" />
                {link.isPending ? 'Connecting…' : 'Connect'}
              </Button>
            </div>
          </div>
        )}
      </PanelContent>
    </Panel>
  )
}
