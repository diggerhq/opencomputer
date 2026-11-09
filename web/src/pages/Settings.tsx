import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { notifyError } from '@/lib/errors'
import { useTransientFlag } from '@/lib/use-transient-flag'
import { ME_QUERY_KEY, useAuth } from '@/hooks/useAuth'
import { organizationPlanLabel } from '@/lib/plan-label'
import {
  getAutumnBilling,
  getBilling,
  getInvitations,
  getOrg,
  getOrgMembers,
  removeMember,
  revokeInvitation,
  sendInvitation,
  updateOrg,
  updateNavigationPreferences,
  type NavigationPreferenceUpdate,
  type OrgInvitation,
  type OrgMember,
} from '@/api/client'
import { PageHeader } from '@/components/page-header'
import {
  Panel,
  PanelHeader,
  PanelTitle,
  PanelDescription,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Field, Input, Label } from '@/components/form'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getManagedRuntimeProfile } from '@/managed-agents/api'

function ReadOnlyField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="bg-panel-2 text-muted-foreground flex h-8 items-center rounded-md border px-3 font-mono text-sm">
        {value}
      </div>
    </div>
  )
}

export default function Settings() {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const { data: org, isLoading } = useQuery({
    queryKey: ['org'],
    queryFn: getOrg,
  })
  const { data: billing, isLoading: isBillingLoading } = useQuery({
    queryKey: ['billing'],
    queryFn: getBilling,
  })
  const usesAutumnBilling = billing?.billingProvider === 'autumn'
  const { data: autumn, isLoading: isAutumnLoading } = useQuery({
    queryKey: ['autumn-billing'],
    queryFn: getAutumnBilling,
    enabled: usesAutumnBilling,
  })
  const {
    data: runtimeProfile,
    isLoading: runtimeProfileLoading,
    isError: runtimeProfileError,
  } = useQuery({
    queryKey: ['managed-runtime-profile'],
    queryFn: getManagedRuntimeProfile,
    retry: false,
  })

  // Local edits override the fetched name; null = "not edited" (avoids an
  // effect to sync the field with the query).
  const [draftName, setDraftName] = useState<string | null>(null)
  const [saved, markSaved] = useTransientFlag(2000)
  const [showRuntimeProfileInfo, setShowRuntimeProfileInfo] = useState(false)
  const name = draftName ?? org?.name ?? ''

  const saveMutation = useMutation({
    mutationFn: (n: string) => updateOrg({ name: n }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['org'], updated)
      setDraftName(null)
      markSaved()
    },
    onError: (e) => notifyError("Couldn't save organization settings.", e),
  })

  const navigationMutation = useMutation({
    mutationFn: (updates: NavigationPreferenceUpdate) =>
      updateNavigationPreferences(updates),
    onSuccess: (updated) => queryClient.setQueryData(ME_QUERY_KEY, updated),
    onError: (e) => notifyError("Couldn't save navigation settings.", e),
  })

  if (isLoading || isBillingLoading || (usesAutumnBilling && isAutumnLoading)) {
    return (
      <div>
        <PageHeader title="Settings" description="Organization configuration" />
        <div className="max-w-2xl space-y-6">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    )
  }

  const unchanged = name === (org?.name ?? '')
  const plan = organizationPlanLabel(org, billing, autumn)

  return (
    <div>
      <PageHeader title="Settings" description="Organization configuration" />

      <div className="grid max-w-5xl grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel className="p-6 lg:col-span-2">
          <div className="mb-5">
            <PanelTitle>Navigation</PanelTitle>
            <PanelDescription className="mt-1">
              Choose which advanced product areas appear in the sidebar.
            </PanelDescription>
          </div>
          <div className="divide-y">
            <NavigationToggle
              id="infrastructure-enabled"
              label="Enable infrastructure"
              description="Show browsers."
              checked={user?.infrastructureEnabled ?? false}
              disabled={navigationMutation.isPending}
              onCheckedChange={(checked) =>
                navigationMutation.mutate({ infrastructureEnabled: checked })
              }
            />
          </div>
        </Panel>

        <Panel className="p-6 lg:col-span-2">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <PanelTitle>Customize VM packages</PanelTitle>
              <PanelDescription className="mt-1">
                Select the tools available to agents when they start a VM.
              </PanelDescription>
              <div className="mt-4">
                <Label>Selected package image</Label>
                <p className="text-foreground mt-1 text-sm font-medium">
                  {runtimeProfileLoading
                    ? 'Loading…'
                    : runtimeProfileError
                      ? 'Unavailable'
                      : (runtimeProfile?.displayName ?? 'OpenComputer default')}
                </p>
                {runtimeProfile?.customized ? (
                  <p className="text-muted-foreground mt-1 text-xs">
                    A dedicated image is assigned to this organization.
                  </p>
                ) : null}
              </div>
            </div>
            <Button
              variant="outline"
              onClick={() => setShowRuntimeProfileInfo(true)}
            >
              Edit
            </Button>
          </div>
        </Panel>

        {/* Organization */}
        <Panel className="p-6">
          <div className="mb-5">
            <PanelTitle>Organization</PanelTitle>
            <PanelDescription className="mt-1">
              Your organization&apos;s name and plan.
            </PanelDescription>
          </div>
          <div className="space-y-5">
            <Field label="Organization name" htmlFor="org-name">
              <Input
                id="org-name"
                value={name}
                onChange={(e) => setDraftName(e.target.value)}
              />
            </Field>

            <ReadOnlyField label="Plan" value={plan} />

            <ReadOnlyField label="Organization ID" value={org?.id ?? '—'} />

            <div className="flex items-center gap-3">
              <Button
                onClick={() => saveMutation.mutate(name)}
                disabled={saveMutation.isPending || unchanged}
              >
                {saveMutation.isPending ? 'Saving…' : 'Save changes'}
              </Button>
              {saved ? (
                <span className="text-status-running text-sm font-medium">
                  Saved
                </span>
              ) : null}
            </div>
          </div>
        </Panel>

        {user?.capabilities?.manageMembers !== false ? (
          <>
            <div className="lg:col-span-2">
              <TeamMembers />
            </div>
            <div className="lg:col-span-2">
              <PendingInvitations />
            </div>
          </>
        ) : null}
      </div>

      <Dialog
        open={showRuntimeProfileInfo}
        onOpenChange={setShowRuntimeProfileInfo}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Custom VM packages</DialogTitle>
            <DialogDescription>
              Custom package images are an Enterprise feature. The OpenComputer
              team builds and validates a dedicated image, then assigns it to
              your organization. Book a call with the team to get it set up.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Got it</Button>
            </DialogClose>
            <Button asChild>
              <a
                href="https://cal.com/team/digger/opencomputer-founder-chat"
                target="_blank"
                rel="noreferrer"
              >
                Book a call
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function NavigationToggle({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  disabled: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-4 first:pt-0 last:pb-0">
      <div>
        <Label htmlFor={id}>{label}</Label>
        <p className="text-muted-foreground mt-1 text-sm">{description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  )
}

function TeamMembers() {
  const queryClient = useQueryClient()
  const { data: members, isLoading } = useQuery({
    queryKey: ['org-members'],
    queryFn: getOrgMembers,
  })

  const [inviteEmail, setInviteEmail] = useState('')
  const [showInvite, setShowInvite] = useState(false)
  const [toRemove, setToRemove] = useState<OrgMember | null>(null)

  const inviteMutation = useMutation({
    mutationFn: (email: string) => sendInvitation(email),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['org-members'] })
      void queryClient.invalidateQueries({ queryKey: ['org-invitations'] })
      setInviteEmail('')
      setShowInvite(false)
    },
    onError: (e) => notifyError("Couldn't send the invitation.", e),
  })

  const removeMutation = useMutation({
    mutationFn: (membershipId: string) => removeMember(membershipId),
    onError: (e) => notifyError("Couldn't remove the member.", e),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: ['org-members'] }),
  })

  return (
    <Panel className="p-6">
      <PanelHeader className="border-0 p-0">
        <div>
          <PanelTitle>Team members</PanelTitle>
          <PanelDescription className="mt-1">
            People with access to this organization
          </PanelDescription>
        </div>
        <Button size="sm" onClick={() => setShowInvite((v) => !v)}>
          Invite
        </Button>
      </PanelHeader>

      {showInvite ? (
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (inviteEmail.trim()) inviteMutation.mutate(inviteEmail.trim())
          }}
        >
          <Input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="email@example.com"
            className="flex-1"
          />
          <Button
            type="submit"
            disabled={inviteMutation.isPending || !inviteEmail.trim()}
          >
            {inviteMutation.isPending ? 'Sending…' : 'Send'}
          </Button>
        </form>
      ) : null}

      <div className="mt-4 divide-y">
        {isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : (members ?? []).length === 0 ? (
          <p className="text-muted-foreground py-2 text-sm">No members yet.</p>
        ) : (
          (members ?? []).map((member, i) => (
            <div
              key={member.membershipId || member.id || i}
              className="flex items-center justify-between py-3"
            >
              <div className="min-w-0">
                <div className="text-foreground truncate text-sm font-medium">
                  {member.name || member.email}
                </div>
                <div className="text-muted-foreground truncate text-xs">
                  {member.email}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground text-xs tracking-wide uppercase">
                  {member.role}
                </span>
                {member.membershipId ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-status-error"
                    onClick={() => setToRemove(member)}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>

      <ConfirmDialog
        open={toRemove !== null}
        onOpenChange={(open) => !open && setToRemove(null)}
        title={`Remove ${toRemove?.email ?? 'this member'}?`}
        description="They will lose access to this organization."
        confirmLabel="Remove member"
        destructive
        pending={removeMutation.isPending}
        onConfirm={() => {
          if (!toRemove?.membershipId) return
          removeMutation.mutate(toRemove.membershipId, {
            onSuccess: () => setToRemove(null),
          })
        }}
      />
    </Panel>
  )
}

function PendingInvitations() {
  const queryClient = useQueryClient()
  const { data: invitations, isLoading } = useQuery({
    queryKey: ['org-invitations'],
    queryFn: getInvitations,
  })
  const [toRevoke, setToRevoke] = useState<OrgInvitation | null>(null)

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeInvitation(id),
    onError: (e) => notifyError("Couldn't revoke the invitation.", e),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: ['org-invitations'] }),
  })

  const pending = (invitations ?? []).filter((inv) => inv.state === 'pending')

  // Render only once we know there are pending invitations — never during the
  // initial load, so the panel doesn't flash in and then vanish when empty.
  if (isLoading || pending.length === 0) return null

  return (
    <Panel className="p-6">
      <div className="mb-1">
        <PanelTitle>Pending invitations</PanelTitle>
        <PanelDescription className="mt-1">
          Invitations waiting to be accepted
        </PanelDescription>
      </div>

      <div className="mt-3 divide-y">
        {pending.map((inv) => (
          <div key={inv.id} className="flex items-center justify-between py-3">
            <div className="min-w-0">
              <div className="text-foreground truncate text-sm font-medium">
                {inv.email}
              </div>
              <div className="text-muted-foreground truncate text-xs">
                {inv.state} · expires{' '}
                {new Date(inv.expiresAt).toLocaleDateString()}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-status-error"
              onClick={() => setToRevoke(inv)}
            >
              Revoke
            </Button>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={toRevoke !== null}
        onOpenChange={(open) => !open && setToRevoke(null)}
        title={`Revoke invitation for ${toRevoke?.email ?? ''}?`}
        confirmLabel="Revoke invitation"
        destructive
        pending={revokeMutation.isPending}
        onConfirm={() => {
          if (!toRevoke) return
          revokeMutation.mutate(toRevoke.id, {
            onSuccess: () => setToRevoke(null),
          })
        }}
      />
    </Panel>
  )
}
