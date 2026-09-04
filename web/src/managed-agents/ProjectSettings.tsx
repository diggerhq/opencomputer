import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Loader2, Trash2 } from 'lucide-react'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { deleteManagedProject } from './api'
import { canConfirmProjectDeletion } from './project-settings'

export function ManagedProjectSettings({
  projectId,
  projectName,
}: {
  projectId: string
  projectName: string
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const confirmationInput = useRef<HTMLInputElement>(null)
  const remove = useMutation({
    mutationFn: () => deleteManagedProject(projectId),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['managed-project', projectId] })
      void queryClient.invalidateQueries({ queryKey: ['managed-projects'] })
      notifySuccess('Project deleted.')
      void navigate('/', { replace: true })
    },
    onError: (error) => notifyError("Couldn't delete the project.", error),
  })
  const confirmed = canConfirmProjectDeletion(confirmation, projectName)

  return (
    <>
      <Panel className="border-destructive/40">
        <PanelHeader>
          <div>
            <PanelTitle>Delete project</PanelTitle>
            <PanelDescription className="mt-1">
              Permanently remove this project and its agents, deployments,
              sessions, credentials, triggers, and environment configuration.
            </PanelDescription>
          </div>
        </PanelHeader>
        <PanelContent>
          <Button
            variant="destructive"
            onClick={() => {
              setConfirmation('')
              setDialogOpen(true)
              requestAnimationFrame(() => confirmationInput.current?.focus())
            }}
          >
            <Trash2 /> Delete project
          </Button>
        </PanelContent>
      </Panel>

      <AlertDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (remove.isPending) return
          setDialogOpen(open)
          if (!open) setConfirmation('')
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {projectName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. Active sessions will end, project access
              tokens will stop working, and linked local checkouts will need to
              link or create a project before deploying again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="project-delete-confirmation">
              Type <span className="font-mono">{projectName}</span> to confirm
            </Label>
            <Input
              id="project-delete-confirmation"
              ref={confirmationInput}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              Cancel
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={!confirmed || remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Trash2 aria-hidden />
              )}
              Delete project
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
