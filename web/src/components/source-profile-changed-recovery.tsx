import { useState } from 'react'
import { ExternalLink, Unplug } from 'lucide-react'
import type { DeploymentSource } from '@/api/schemas'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { sourceChangesUrl } from '@/lib/source-profile-recovery'

/**
 * Recovery for a pinned repository whose current source is no longer the
 * profile it was imported as. Unlinking stops push-to-deploy; it does not
 * convert or delete the agent, its active revision, or its sessions.
 */
export function SourceProfileChangedRecovery({
  source,
  pending,
  onUnlink,
}: {
  source: DeploymentSource
  pending: boolean
  onUnlink: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const changesUrl = sourceChangesUrl(source)

  return (
    <>
      <Alert variant="destructive">
        <AlertTitle>
          This repository no longer matches the agent type it was imported as
        </AlertTitle>
        <AlertDescription>
          Restore the Flue agent definition, or unlink this source and import
          the repository as a new agent. Unlinking does not convert or delete
          this agent; its current active revision and sessions remain available.
        </AlertDescription>
        <div className="mt-3 flex flex-wrap gap-2">
          {changesUrl ? (
            <Button size="sm" variant="outline" asChild>
              <a href={changesUrl} target="_blank" rel="noreferrer">
                View source changes
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setConfirming(true)}
          >
            <Unplug className="size-4" />
            Unlink source
          </Button>
        </div>
      </Alert>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Unlink this repository?"
        description="Push-to-deploy will stop. The existing agent, its active revision, and its sessions will remain available."
        confirmLabel="Unlink source"
        destructive
        pending={pending}
        onConfirm={onUnlink}
      />
    </>
  )
}
