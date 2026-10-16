import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Loader2, Send } from 'lucide-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { notifyError, notifySuccess } from '@/lib/errors'
import { useTransientFlag } from '@/lib/use-transient-flag'
import {
  computerQueryKey,
  startComputerSlackInstall,
  unlinkComputerSlack,
} from './computer-api'

// The organization's Slack app, shared by the computer page and Connections.

export function SlackInstallButton({
  variant = 'default',
  size = 'default',
  label = 'Install Slack app',
}: {
  variant?: 'default' | 'outline'
  size?: 'default' | 'sm' | 'lg'
  label?: string
}) {
  const install = useMutation({
    mutationFn: () => startComputerSlackInstall(),
    onSuccess: (url) => window.location.assign(url),
    onError: (error) => notifyError("Couldn't start the Slack install.", error),
  })
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

/**
 * For members who can't add apps: a link a Slack admin can open to install it
 * for this organization, without an OpenComputer account.
 */
export function SlackAdminLink() {
  const [copied, markCopied] = useTransientFlag(1500)
  const copy = (url: string) =>
    // navigator.clipboard is missing outside secure contexts, and Safari
    // refuses it once the click that asked has been awaited.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(url))
      .then(markCopied)
  const link = useMutation({
    mutationFn: () => startComputerSlackInstall({ share: true }),
    // The first copy rides the click; the button below copies it again.
    onSuccess: (url) => copy(url).catch(() => undefined),
    onError: (error) => notifyError("Couldn't make the link.", error),
  })
  if (!link.data) {
    return (
      <p className="text-xs">
        Not a Slack admin?{' '}
        <button
          type="button"
          className="text-foreground underline underline-offset-2 disabled:opacity-60"
          disabled={link.isPending}
          onClick={() => link.mutate()}
        >
          Get a link for your admin
        </button>
      </p>
    )
  }
  const url = link.data
  // Inline, like the link that made it, so the two share a baseline.
  return (
    <p className="text-xs">
      Send this link to a Slack admin. It works once, for 7 days, and this page
      moves on when they're done.{' '}
      <button
        type="button"
        className="text-foreground inline-flex items-center gap-1 align-bottom underline underline-offset-2"
        onClick={() =>
          void copy(url).catch((error: unknown) =>
            notifyError("Couldn't copy.", error),
          )
        }
      >
        {copied ? (
          <Check className="size-3" aria-hidden />
        ) : (
          <Copy className="size-3" aria-hidden />
        )}
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </p>
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
