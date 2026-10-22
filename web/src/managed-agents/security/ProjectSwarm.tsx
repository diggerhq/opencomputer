import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { Loader2, Radar } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import {
  getManagedMemoryDocument,
  getManagedMemoryDocuments,
} from '../api'
import {
  latestManifestId,
  parseRunManifest,
  SECURITY_FINDINGS_RESOURCE,
} from './catalog'
import { SwarmGrid } from './SwarmGrid'

// The swarm page for a deployed CVE Swarm project. The launch records a run
// manifest under the findings resource; here we read the latest one back and
// render its grid, so the run is reachable by URL and survives a reload — the
// grid's own React state no longer holds the session ids.
export default function ProjectSwarm() {
  const { projectId = '' } = useParams()

  const manifest = useQuery({
    queryKey: ['swarm-manifest', projectId],
    enabled: Boolean(projectId),
    queryFn: async () => {
      const page = await getManagedMemoryDocuments({
        projectId,
        resource: SECURITY_FINDINGS_RESOURCE,
        environment: 'default',
      })
      const id = latestManifestId(page.documents)
      if (!id) return null
      const read = await getManagedMemoryDocument({
        projectId,
        resource: SECURITY_FINDINGS_RESOURCE,
        environment: 'default',
        id,
      })
      return parseRunManifest(read.document.text)
    },
  })

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <PageHeader
        title="CVE Swarm"
        description="Each cell proves whether one CVE is reachable in one repository. Open a cell to read its full session."
        className="mb-6"
      />
      {manifest.isPending ? (
        <div className="text-muted-foreground inline-flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading the latest run…
        </div>
      ) : manifest.data ? (
        <SwarmGrid
          projectId={projectId}
          runId={manifest.data.runId}
          cells={manifest.data.cells}
          target={manifest.data.target}
          model={manifest.data.model}
        />
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
