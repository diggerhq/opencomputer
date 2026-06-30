import { useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileArchive, Upload } from 'lucide-react'
import JSZip from 'jszip'
import { notifyError } from '@/lib/errors'
import { getAgentRevision, deployAgentRevision, type Agent } from '@/api/client'
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
 * Parse a skills .zip into the deploy `skills[]` payload (path/content/mode). Strips a single
 * common top-level wrapper dir (so zipping `skills/` or `my-agent/` both work), skips macOS +
 * dotfiles, and marks `.sh` / exec-bit files 0755. The API validates limits (64 files / 256 KiB /
 * UTF-8 text) and 400s on violation.
 */
async function zipToSkills(file: File): Promise<{ path: string; content: string; mode: number }[]> {
  const zip = await JSZip.loadAsync(file)
  const entries = Object.values(zip.files)
    .filter((f) => !f.dir)
    .filter((f) => !f.name.startsWith('__MACOSX/') && !f.name.split('/').some((s) => s.startsWith('.')))
  if (entries.length === 0) throw new Error('The zip has no files.')
  const tops = entries.map((f) => f.name.split('/')[0])
  const commonTop = entries.every((f) => f.name.includes('/')) && tops.every((t) => t === tops[0]) ? tops[0] : null
  const skills: { path: string; content: string; mode: number }[] = []
  for (const f of entries) {
    const path = commonTop ? f.name.slice(commonTop.length + 1) : f.name
    if (!path) continue
    const content = await f.async('string')
    const execBit = (typeof f.unixPermissions === 'number' ? f.unixPermissions : 0) & 0o111
    skills.push({ path, content, mode: execBit || /\.sh$/.test(path) ? 0o755 : 0o644 })
  }
  return skills
}

/**
 * Skills panel — shows the active revision's skill files and lets you upload a .zip to deploy a
 * new revision with those skills (the deploy is a full behavior payload, so we carry the agent's
 * current prompt + model; skills[] is the complete set — an upload replaces, it doesn't merge).
 */
export function AgentSkills({ agentId, agent }: { agentId: string; agent: Agent }) {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const activeNumber = agent.active_revision?.number

  const { data: revision } = useQuery({
    queryKey: ['agent-revision-detail', agentId, activeNumber],
    queryFn: () => getAgentRevision(agentId, activeNumber!),
    enabled: activeNumber != null,
  })
  const files = revision?.files ?? []

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const skills = await zipToSkills(file)
      return deployAgentRevision(agentId, { prompt: agent.prompt ?? '', model: agent.model, skills })
    },
    onSuccess: () => {
      // A skills deploy creates a new active revision — refresh the dependent views.
      void queryClient.invalidateQueries({ queryKey: ['agent-revisions', agentId] })
      void queryClient.invalidateQueries({ queryKey: ['agent-deploys', agentId] })
      void queryClient.invalidateQueries({ queryKey: ['agent-revision-detail', agentId] })
      void queryClient.invalidateQueries({ queryKey: ['agent', agentId] })
    },
    onError: (e) => notifyError("Couldn't deploy the skills.", e),
  })

  const canUpload = !!agent.prompt && !uploadMutation.isPending

  return (
    <Panel className="overflow-hidden">
      <PanelHeader>
        <PanelTitle>Skills</PanelTitle>
        <span className="text-muted-foreground text-xs">
          Files Claude Code loads for this agent.
        </span>
      </PanelHeader>
      <PanelContent className="space-y-4">
        {files.length === 0 ? (
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
              if (f) uploadMutation.mutate(f)
              e.target.value = '' // allow re-selecting the same file
            }}
          />
          <Button size="sm" disabled={!canUpload} onClick={() => inputRef.current?.click()}>
            <Upload className="size-4" />
            {uploadMutation.isPending
              ? 'Deploying…'
              : files.length
                ? 'Replace skills (.zip)'
                : 'Upload skills (.zip)'}
          </Button>
          <p className="text-muted-foreground text-xs">
            {agent.prompt
              ? 'Deploys a new revision; prompt & model unchanged.'
              : 'Set a system prompt first.'}
          </p>
        </div>
      </PanelContent>
    </Panel>
  )
}
