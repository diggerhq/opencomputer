import { useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileArchive, Upload } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import { getAgentSkills, putAgentSkills, deleteAgentSkills } from '@/api/client'
import {
  Panel,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`)

/**
 * Skills panel — a thin consumer of the agent skills sub-resource (design 009 §8). The API owns
 * unzip + validate + canonicalize + bundle: we just GET the file list, PUT a raw .zip to deploy a
 * new revision (active behavior, skills replaced), or DELETE to clear. No client-side parsing.
 */
export function AgentSkills({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['agent-skills', agentId],
    queryFn: () => getAgentSkills(agentId),
  })
  const files = data?.files ?? []

  // A skills change deploys a new active revision — refresh the dependent views.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['agent-skills', agentId] })
    void queryClient.invalidateQueries({ queryKey: ['agent-revisions', agentId] })
    void queryClient.invalidateQueries({ queryKey: ['agent-deploys', agentId] })
    void queryClient.invalidateQueries({ queryKey: ['agent', agentId] })
  }
  const upload = useMutation({
    mutationFn: (zip: File) => putAgentSkills(agentId, zip),
    onSuccess: invalidate,
    onError: (e) => notifyError("Couldn't upload the skills.", e),
  })
  const remove = useMutation({
    mutationFn: () => deleteAgentSkills(agentId),
    onSuccess: invalidate,
    onError: (e) => notifyError("Couldn't remove the skills.", e),
  })
  const busy = upload.isPending || remove.isPending

  return (
    <Panel className="overflow-hidden">
      <PanelHeader>
        <PanelTitle>Skills</PanelTitle>
        <span className="text-muted-foreground text-xs">
          Files Claude Code loads for this agent.
        </span>
      </PanelHeader>
      <PanelContent className="space-y-4">
        {!isLoading && files.length === 0 ? (
          <EmptyState
            icon={FileArchive}
            title="No skills deployed"
            description="Upload a .zip of your skills folder to deploy a revision with them."
          />
        ) : (
          <ul className="divide-border divide-y rounded-md border">
            {files.map((f) => (
              <li key={f.path} className="flex items-center justify-between px-3 py-2">
                <span className="text-foreground font-mono text-xs">{f.path}</span>
                <span className="text-muted-foreground font-mono text-xs">
                  {(f.mode & 0o777).toString(8)} · {fmtBytes(f.size)}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) upload.mutate(f)
              e.target.value = '' // allow re-selecting the same file
            }}
          />
          <Button size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
            <Upload className="size-4" />
            {upload.isPending
              ? 'Uploading…'
              : files.length
                ? 'Replace skills (.zip)'
                : 'Upload skills (.zip)'}
          </Button>
          {files.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              disabled={busy}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? 'Removing…' : 'Remove all'}
            </Button>
          ) : null}
          <p className="text-muted-foreground ml-auto text-xs">
            Deploys a new revision; prompt &amp; model unchanged.
          </p>
        </div>
      </PanelContent>
    </Panel>
  )
}
