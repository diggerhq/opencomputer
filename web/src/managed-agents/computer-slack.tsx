import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Send } from 'lucide-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  computerQueryKey,
  startComputerSlackInstall,
  unlinkComputerSlack,
} from './computer-api'

// The organization's Slack app, shared by the computer page and Connections.

function useSlackInstall() {
  return useMutation({
    mutationFn: startComputerSlackInstall,
    onSuccess: (url) => window.location.assign(url),
    onError: (error) => notifyError("Couldn't start the Slack install.", error),
  })
}

export function SlackInstallButton({
  variant = 'default',
  size = 'default',
  label = 'Install Slack app',
}: {
  variant?: 'default' | 'outline'
  size?: 'default' | 'sm' | 'lg'
  label?: string
}) {
  const install = useSlackInstall()
  return (
    <Button
      variant={variant}
      size={size}
      // Stays pending through the navigation to Slack.
      disabled={install.isPending || install.isSuccess}
      onClick={() => install.mutate()}
    >
      {install.isPending || install.isSuccess ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <Send className="size-4" aria-hidden />
      )}
      {label}
    </Button>
  )
}

/** The same install, as a quiet text link beside a bigger call to action. */
export function SlackInstallLink({
  label,
  onClick,
}: {
  label: string
  onClick?: () => void
}) {
  const install = useSlackInstall()
  const pending = install.isPending || install.isSuccess
  return (
    <button
      type="button"
      // Stays pending through the navigation to Slack.
      disabled={pending}
      onClick={() => {
        onClick?.()
        install.mutate()
      }}
      className="hover:text-foreground decoration-muted-foreground/40 inline-flex items-center gap-1.5 underline underline-offset-4 transition-colors disabled:opacity-60"
    >
      {pending ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
      {label}
    </button>
  )
}

export function UnlinkSlackDialog({
  teamName,
  open,
  onOpenChange,
}: {
  teamName?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const unlink = useMutation({
    mutationFn: unlinkComputerSlack,
    onSuccess: async () => {
      onOpenChange(false)
      await queryClient.invalidateQueries({ queryKey: computerQueryKey })
      notifySuccess(
        'Slack workspace unlinked.',
        'Remove the app in Slack to uninstall it there too.',
      )
    },
    onError: (error) => notifyError("Couldn't unlink Slack.", error),
  })
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Unlink ${teamName ?? 'this Slack workspace'}?`}
      description="Your computer stops answering in this workspace. The app stays installed in Slack until you remove it there, and you can link a workspace again at any time."
      confirmLabel="Unlink Slack"
      destructive
      pending={unlink.isPending}
      onConfirm={() => unlink.mutate()}
    />
  )
}
