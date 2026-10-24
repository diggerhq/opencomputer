import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ChevronRight, Loader2, Radar } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import {
  getManagedMemoryDocument,
  getManagedMemoryDocuments,
} from '../api'
import {
  listManifestDocs,
  parseRunManifest,
  SECURITY_FINDINGS_RESOURCE,
} from './catalog'

type RunRow = {
  runId: string
  target: string
  model: string
  cells: number
  updatedAt: string
}

// The index of every swarm run in a project: one row per manifest, newest first,
// each linking to its run detail page (map / grid). This is what the "Swarms"
// nav item lands on.
export default function ProjectSwarms() {
  const { projectId = '' } = useParams()

  const runs = useQuery({
    queryKey: ['swarm-runs', projectId],
    enabled: Boolean(projectId),
    queryFn: async (): Promise<RunRow[]> => {
      // The findings resource holds one `manifest__` doc per run alongside every
      // cell's finding doc, and the list endpoint pages at 50 newest-first by
      // `updatedAt`. A busy run (dozens of cells, each rewriting its finding doc)
      // pushes the now-static manifest past page 1, so reading only the first
      // page shows "no swarm has run" even when runs exist. Follow the cursor to
      // gather every doc, then filter to manifests. Bounded so a runaway feed
      // can't loop without limit.
      const MAX_PAGES = 50
      const docs: { id: string; updatedAt: string }[] = []
      let cursor: string | undefined
      for (let i = 0; i < MAX_PAGES; i += 1) {
        const page = await getManagedMemoryDocuments({
          projectId,
          resource: SECURITY_FINDINGS_RESOURCE,
          environment: 'default',
          cursor,
        })
        docs.push(...page.documents)
        if (!page.nextCursor) break
        cursor = page.nextCursor
      }
      const manifests = listManifestDocs(docs)
      const rows = await Promise.all(
        manifests.map(async ({ id, updatedAt }) => {
          const read = await getManagedMemoryDocument({
            projectId,
            resource: SECURITY_FINDINGS_RESOURCE,
            environment: 'default',
            id,
          })
          const manifest = parseRunManifest(read.document.text)
          if (!manifest) return null
          return {
            runId: manifest.runId,
            target: manifest.target,
            model: manifest.model,
            cells: manifest.cells.length,
            updatedAt,
          } satisfies RunRow
        }),
      )
      return rows.filter((r): r is RunRow => r !== null)
    },
  })

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <PageHeader
        title="Swarms"
        description="Every CVE swarm run in this project. Open one to watch its map or grid and read its report."
        className="mb-6"
        actions={
          runs.data && runs.data.length > 0 ? (
            <Button asChild>
              <Link to="/security">
                <Radar className="size-4" /> New swarm
              </Link>
            </Button>
          ) : undefined
        }
      />
      {runs.isPending ? (
        <div className="text-muted-foreground inline-flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading runs…
        </div>
      ) : runs.data && runs.data.length > 0 ? (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Target</th>
                <th className="px-4 py-2 text-left font-medium">Model</th>
                <th className="px-4 py-2 text-right font-medium">Cells</th>
                <th className="px-4 py-2 text-left font-medium">Started</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {runs.data.map((run) => (
                <tr key={run.runId} className="hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <Link
                      to={`/projects/${encodeURIComponent(projectId)}/swarms/${encodeURIComponent(run.runId)}`}
                      className="font-medium hover:underline"
                    >
                      {run.target || run.runId}
                    </Link>
                    <div className="text-muted-foreground font-mono text-xs">
                      {run.runId}
                    </div>
                  </td>
                  <td className="text-muted-foreground px-4 py-3 font-mono text-xs">
                    {run.model || '—'}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {run.cells}
                  </td>
                  <td className="text-muted-foreground px-4 py-3 text-xs">
                    {new Date(run.updatedAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      to={`/projects/${encodeURIComponent(projectId)}/swarms/${encodeURIComponent(run.runId)}`}
                      className="text-muted-foreground hover:text-foreground inline-flex items-center"
                    >
                      <ChevronRight className="size-4" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <Radar className="text-muted-foreground mx-auto size-6" />
          <p className="text-muted-foreground mt-3 text-sm">
            No swarm has run in this project yet.
          </p>
          <Button asChild variant="outline" className="mt-4">
            <Link to="/security">Launch a swarm</Link>
          </Button>
        </div>
      )}
    </div>
  )
}
