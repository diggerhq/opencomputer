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
  const skills = data?.skills ?? []

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
        {!isLoading && skills.length === 0 ? (
          <div className="space-y-3">
            <EmptyState
              icon={FileArchive}
              title="No skills yet"
              description="A skill is a folder with a SKILL.md. Upload a .zip shaped like:"
            />
            <pre className="text-muted-foreground/70 mx-auto w-fit text-left font-mono text-xs leading-relaxed">
{`skills/
├─ triage/
│  └─ SKILL.md
└─ pr-review/
   ├─ SKILL.md
   └─ run.sh`}
            </pre>
          </div>
        ) : (
          <ul className="divide-border divide-y rounded-md border">
            {skills.map((s) => (
              <li key={s.name} className="px-3 py-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-foreground font-mono text-[13px]">{s.name}</span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {s.files.length} file{s.files.length === 1 ? '' : 's'} ·{' '}
                    {fmtBytes(s.files.reduce((n, f) => n + f.size, 0))}
                  </span>
                </div>
                {s.description ? (
                  <p className="text-muted-foreground mt-0.5 text-xs">{s.description}</p>
                ) : (
                  <p className="text-muted-foreground/70 mt-0.5 text-xs italic">no description</p>
                )}
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
              : skills.length
                ? 'Replace skills (.zip)'
                : 'Upload skills (.zip)'}
          </Button>
          {skills.length > 0 ? (
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
