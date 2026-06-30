import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitBranch, Plug, Unplug } from 'lucide-react'
import { notifyError, notifySuccess } from '@/lib/errors'
import { getDeploymentSource, linkDeploymentSource, unlinkDeploymentSource } from '@/api/client'
import {
  Panel,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/form'

const GITHUB_APP_INSTALL = 'https://github.com/apps/opencomputerdev/installations/new'

// Human label + tone for each link status (matches agent_deployment_sources.status).
const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'err' }> = {
  active: { label: 'Connected', tone: 'ok' },
  path_missing: { label: 'Directory not found', tone: 'err' },
  ref_missing: { label: 'Production branch deleted', tone: 'err' },
  auth_required: { label: 'App not installed on this repo', tone: 'warn' },
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
 * Deploy-from-a-repo panel — bind the agent to a repo directory so a push deploys it. Linking uses
 * the OpenComputer GitHub App (no BYO for deployment sources) and deploys the production branch
 * immediately. A push to the production branch then activates; other branches stage.
 */
export function AgentDeploySource({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient()
  const [repo, setRepo] = useState('')
  const [path, setPath] = useState('')
  const [branch, setBranch] = useState('main')

  const { data: source, isLoading } = useQuery({
    queryKey: ['agent-deploy-source', agentId],
    // 404 = not linked. Tolerate a transient blip by showing the connect form rather than an error.
    queryFn: async () => {
      try {
        return (await getDeploymentSource(agentId)).source
      } catch {
        return null
      }
    },
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['agent-deploy-source', agentId] })
    void queryClient.invalidateQueries({ queryKey: ['agent-deploys', agentId] })
    void queryClient.invalidateQueries({ queryKey: ['agent-revisions', agentId] })
    void queryClient.invalidateQueries({ queryKey: ['agent', agentId] })
  }

  const link = useMutation({
    mutationFn: () =>
      linkDeploymentSource(agentId, {
        repo: repo.trim(),
        path: path.trim(),
        production_ref: branch.trim() || 'main',
      }),
    onSuccess: (r) => {
      invalidate()
      if (r.deploy_error) {
        notifyError(
          `Repo connected, but the first deploy couldn't run (${r.deploy_error.message}). Install the GitHub App on the repo, then deploy again.`,
          new Error(r.deploy_error.type),
        )
      } else {
        notifySuccess('Repo connected — deploying the production branch.')
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

  const st = source ? (STATUS[source.status] ?? { label: source.status, tone: 'warn' as const }) : null

  return (
    <Panel className="overflow-hidden">
      <PanelHeader>
        <PanelTitle>Deploy from a repo</PanelTitle>
        <span className="text-muted-foreground text-xs">Push to a branch to deploy this agent.</span>
      </PanelHeader>
      <PanelContent className="space-y-4">
        {isLoading ? (
          <p className="text-muted-foreground text-xs">Loading…</p>
        ) : source && st ? (
          // ── Connected ──
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-md border px-4 py-3">
              <div className="space-y-1">
                <div className="text-foreground flex items-center gap-2 font-mono text-[13px]">
                  {source.path ? source.path : '(repo root)'}
                  <span className="text-muted-foreground inline-flex items-center gap-1">
                    <GitBranch className="size-3.5" />
                    {source.production_ref}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className={TONE[st.tone]}>● {st.label}</span>
                  {source.active_deployed_sha ? (
                    <span className="text-muted-foreground font-mono">
                      @ {source.active_deployed_sha.slice(0, 7)}
                    </span>
                  ) : null}
                </div>
              </div>
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
            {st.tone !== 'ok' ? (
              <p className="text-muted-foreground text-xs">
                {source.status === 'auth_required' || source.status === 'repo_not_selected' ? (
                  <>
                    Install / re-select this repo in the{' '}
                    <a className="underline" href={GITHUB_APP_INSTALL} target="_blank" rel="noreferrer">
                      OpenComputer GitHub App
                    </a>
                    , then push again.
                  </>
                ) : (
                  'Fix the issue in the repo, then push again.'
                )}
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                Pushes to <span className="font-mono">{source.production_ref}</span> deploy and
                activate; other branches deploy a staged revision.
              </p>
            )}
          </div>
        ) : (
          // ── Not connected ──
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_8rem]">
              <Field label="Repository">
                <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" />
              </Field>
              <Field label="Directory">
                <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="agents/issue-fixer" />
              </Field>
              <Field label="Branch">
                <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
              </Field>
            </div>
            <div className="flex items-center gap-3">
              <p className="text-muted-foreground text-xs">
                Needs the{' '}
                <a className="underline" href={GITHUB_APP_INSTALL} target="_blank" rel="noreferrer">
                  OpenComputer GitHub App
                </a>{' '}
                installed on the repo. Connecting deploys the branch now.
              </p>
              <Button
                size="sm"
                className="ml-auto"
                disabled={link.isPending || !repo.trim()}
                onClick={() => link.mutate()}
              >
                <Plug className="size-4" />
                {link.isPending ? 'Connecting…' : 'Connect repo'}
              </Button>
            </div>
          </div>
        )}
      </PanelContent>
    </Panel>
  )
}
