import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { notifyError } from '@/lib/errors'
import { useTransientFlag } from '@/lib/use-transient-flag'
import {
  deleteCustomDomain,
  getInvitations,
  getOrg,
  getOrgMembers,
  refreshCustomDomain,
  removeMember,
  revokeInvitation,
  sendInvitation,
  setCustomDomain,
  updateOrg,
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
import { StatusBadge } from '@/components/status-badge'
import { ConfirmDialog } from '@/components/confirm-dialog'

function ReadOnlyField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="bg-panel-2 text-muted-foreground rounded-md border px-3 py-2 font-mono text-sm">
        {value}
      </div>
    </div>
  )
}

// Domain verification / SSL statuses → a lifecycle tone + clean label.
function DomainStatus({ status }: { status: string }) {
  const tone =
    status === 'active'
      ? 'running'
      : !status || status === 'none'
        ? 'stopped'
        : 'pending'
  const label =
    !status || status === 'none' ? 'Not set' : status.replace(/_/g, ' ')
  return <StatusBadge status={tone} label={label} />
}

function CodeBlock({ children }: { children: ReactNode }) {
  return (
    <div className="bg-panel-2 text-muted-foreground rounded-md border p-3 font-mono text-xs leading-relaxed break-all">
      {children}
    </div>
  )
}

export default function Settings() {
  const queryClient = useQueryClient()
  const { data: org, isLoading } = useQuery({
    queryKey: ['org'],
    queryFn: getOrg,
  })

  // Local edits override the fetched name; null = "not edited" (avoids an
  // effect to sync the field with the query).
  const [draftName, setDraftName] = useState<string | null>(null)
  const [saved, markSaved] = useTransientFlag(2000)
  const [domainInput, setDomainInput] = useState('')
  const [confirmRemoveDomain, setConfirmRemoveDomain] = useState(false)
  const name = draftName ?? org?.name ?? ''

  const saveMutation = useMutation({
    mutationFn: (n: string) => updateOrg(n),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org'] })
      setDraftName(null)
      markSaved()
    },
    onError: (e) => notifyError("Couldn't save organization settings.", e),
  })

  const setDomainMutation = useMutation({
    mutationFn: (domain: string) => setCustomDomain(domain),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org'] })
      setDomainInput('')
    },
    onError: (e) => notifyError("Couldn't set the custom domain.", e),
  })

  const deleteDomainMutation = useMutation({
    mutationFn: () => deleteCustomDomain(),
    onError: (e) => notifyError("Couldn't remove the custom domain.", e),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['org'] }),
  })

  const refreshDomainMutation = useMutation({
    mutationFn: () => refreshCustomDomain(),
    onError: (e) => notifyError("Couldn't refresh domain status.", e),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['org'] }),
  })

  if (isLoading) {
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
  const hasDomain = !!org?.customDomain && org.customDomain !== ''

  return (
    <div>
      <PageHeader title="Settings" description="Organization configuration" />

      <div className="max-w-2xl space-y-6">
        {/* Organization */}
        <Panel className="p-6">
          <div className="space-y-5">
            <Field label="Organization name" htmlFor="org-name">
              <Input
                id="org-name"
                value={name}
                onChange={(e) => setDraftName(e.target.value)}
              />
            </Field>

            <ReadOnlyField
              label="Plan"
              value={<span className="capitalize">{org?.plan ?? 'free'}</span>}
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ReadOnlyField
                label="Max concurrent sandboxes"
                value={org?.maxConcurrentSandboxes}
              />
              <ReadOnlyField
                label="Max timeout (sec)"
                value={org?.maxSandboxTimeoutSec}
              />
            </div>

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

        {/* Custom domain */}
        <Panel className="p-6">
          <div className="mb-5">
            <PanelTitle>Custom domain</PanelTitle>
            <PanelDescription className="mt-1">
              Serve sandbox preview URLs from your own domain (e.g.{' '}
              <code className="font-mono text-xs">
                &lt;id&gt;.yourdomain.com
              </code>
              ).
            </PanelDescription>
          </div>

          {hasDomain ? (
            <div className="space-y-4">
              <ReadOnlyField label="Domain" value={`*.${org!.customDomain}`} />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Verification</Label>
                  <div>
                    <DomainStatus status={org!.domainVerificationStatus} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>SSL</Label>
                  <div>
                    <DomainStatus status={org!.domainSslStatus} />
                  </div>
                </div>
              </div>

              {org!.verificationTxtName || org!.sslTxtName ? (
                <div className="space-y-1.5">
                  <Label>Required DNS TXT records</Label>
                  <CodeBlock>
                    {org!.verificationTxtName ? (
                      <div className={org!.sslTxtName ? 'mb-3' : ''}>
                        <div className="text-foreground font-semibold">
                          Domain verification
                        </div>
                        <div>Name: {org!.verificationTxtName}</div>
                        <div>Value: {org!.verificationTxtValue}</div>
                      </div>
                    ) : null}
                    {org!.sslTxtName ? (
                      <div>
                        <div className="text-foreground font-semibold">
                          SSL validation
                        </div>
                        <div>Name: {org!.sslTxtName}</div>
                        <div>Value: {org!.sslTxtValue}</div>
                      </div>
                    ) : null}
                  </CodeBlock>
                </div>
              ) : null}

              {org!.domainVerificationStatus === 'active' ? (
                <div className="space-y-1.5">
                  <Label>Preview URL setup</Label>
                  <CodeBlock>
                    <div className="text-foreground mb-1.5 font-semibold">
                      Add a wildcard CNAME record for preview URLs:
                    </div>
                    <div>
                      Type: <span className="text-foreground">CNAME</span>
                    </div>
                    <div>
                      Name:{' '}
                      <span className="text-foreground">
                        *.{org!.customDomain}
                      </span>
                    </div>
                    <div>
                      Target:{' '}
                      <span className="text-foreground">
                        fallback-origin.opencomputer.dev
                      </span>
                    </div>
                  </CodeBlock>
                </div>
              ) : null}

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => refreshDomainMutation.mutate()}
                  disabled={refreshDomainMutation.isPending}
                >
                  {refreshDomainMutation.isPending
                    ? 'Refreshing…'
                    : 'Refresh status'}
                </Button>
                <Button
                  variant="ghost"
                  className="text-status-error hover:bg-status-error-bg hover:text-status-error"
                  onClick={() => setConfirmRemoveDomain(true)}
                  disabled={deleteDomainMutation.isPending}
                >
                  Remove domain
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                if (domainInput.trim())
                  setDomainMutation.mutate(domainInput.trim())
              }}
            >
              <Field label="Domain" htmlFor="domain">
                <Input
                  id="domain"
                  value={domainInput}
                  onChange={(e) => setDomainInput(e.target.value)}
                  placeholder="acme.dev"
                />
              </Field>
              <Button
                type="submit"
                disabled={setDomainMutation.isPending || !domainInput.trim()}
              >
                {setDomainMutation.isPending ? 'Setting up…' : 'Set domain'}
              </Button>
            </form>
          )}
        </Panel>

        <TeamMembers />
        <PendingInvitations />
      </div>

      <ConfirmDialog
        open={confirmRemoveDomain}
        onOpenChange={setConfirmRemoveDomain}
        title="Remove custom domain?"
        description="Sandbox preview URLs will revert to the default domain."
        confirmLabel="Remove domain"
        destructive
        pending={deleteDomainMutation.isPending}
        onConfirm={() =>
          deleteDomainMutation.mutate(undefined, {
            onSuccess: () => setConfirmRemoveDomain(false),
          })
        }
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
      queryClient.invalidateQueries({ queryKey: ['org-members'] })
      queryClient.invalidateQueries({ queryKey: ['org-invitations'] })
      setInviteEmail('')
      setShowInvite(false)
    },
    onError: (e) => notifyError("Couldn't send the invitation.", e),
  })

  const removeMutation = useMutation({
    mutationFn: (membershipId: string) => removeMember(membershipId),
    onError: (e) => notifyError("Couldn't remove the member.", e),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['org-members'] }),
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
      queryClient.invalidateQueries({ queryKey: ['org-invitations'] }),
  })

  const pending = (invitations ?? []).filter((inv) => inv.state === 'pending')

  if (!isLoading && pending.length === 0) return null

  return (
    <Panel className="p-6">
      <div className="mb-1">
        <PanelTitle>Pending invitations</PanelTitle>
        <PanelDescription className="mt-1">
          Invitations waiting to be accepted
        </PanelDescription>
      </div>

      <div className="mt-3 divide-y">
        {isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          pending.map((inv) => (
            <div
              key={inv.id}
              className="flex items-center justify-between py-3"
            >
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
          ))
        )}
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
