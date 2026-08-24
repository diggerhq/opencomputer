import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { notifyError } from '@/lib/errors'
import { useTransientFlag } from '@/lib/use-transient-flag'
import { useAuth } from '@/hooks/useAuth'
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
  updateNavigationPreferences,
  getModelAccessConnections,
  connectModelAccess,
  disconnectModelAccess,
  validateModelAccessConnection,
  type NavigationPreferenceUpdate,
  type OrgInvitation,
  type OrgMember,
  type ModelAccessConnection,
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
import { Switch } from '@/components/ui/switch'

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
  const { user } = useAuth()
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
    onSuccess: (updated) => queryClient.setQueryData(['me'], updated),
    onError: (e) => notifyError("Couldn't save navigation settings.", e),
  })

  const setDomainMutation = useMutation({
    mutationFn: (domain: string) => setCustomDomain(domain),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['org'] })
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
              id="durable-sessions-enabled"
              label="Enable durable sessions"
              description="Show durable agents, sessions, and credentials."
              checked={user?.durableSessionsEnabled ?? false}
              disabled={navigationMutation.isPending}
              onCheckedChange={(checked) =>
                navigationMutation.mutate({
                  durableSessionsEnabled: checked,
                })
              }
            />
            <NavigationToggle
              id="infrastructure-enabled"
              label="Enable infrastructure"
              description="Show sandboxes, checkpoints, templates, webhooks, and browsers."
              checked={user?.infrastructureEnabled ?? false}
              disabled={navigationMutation.isPending}
              onCheckedChange={(checked) =>
                navigationMutation.mutate({ infrastructureEnabled: checked })
              }
            />
          </div>
        </Panel>

        {/* Model access (work 011) — connect an external Claude/Codex
            subscription. Connection management is org-admin only; the raw
            provider token is write-only and never shown. */}
        <ModelAccessPanel canManage={user?.capabilities?.manageMembers !== false} />

        {/* Organization */}
        <Panel className="p-6">
          <div className="mb-5">
            <PanelTitle>Organization</PanelTitle>
            <PanelDescription className="mt-1">
              Your organization&apos;s name and plan limits.
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
              Serve sandbox preview URLs from your own domain.
            </PanelDescription>
          </div>

          {hasDomain ? (
            <div className="space-y-4">
              <ReadOnlyField label="Domain" value={`*.${org.customDomain}`} />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Verification</Label>
                  <div>
                    <DomainStatus status={org.domainVerificationStatus} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>SSL</Label>
                  <div>
                    <DomainStatus status={org.domainSslStatus} />
                  </div>
                </div>
              </div>

              {org.verificationTxtName || org.sslTxtName ? (
                <div className="space-y-1.5">
                  <Label>Required DNS TXT records</Label>
                  <CodeBlock>
                    {org.verificationTxtName ? (
                      <div className={org.sslTxtName ? 'mb-3' : ''}>
                        <div className="text-foreground font-semibold">
                          Domain verification
                        </div>
                        <div>Name: {org.verificationTxtName}</div>
                        <div>Value: {org.verificationTxtValue}</div>
                      </div>
                    ) : null}
                    {org.sslTxtName ? (
                      <div>
                        <div className="text-foreground font-semibold">
                          SSL validation
                        </div>
                        <div>Name: {org.sslTxtName}</div>
                        <div>Value: {org.sslTxtValue}</div>
                      </div>
                    ) : null}
                  </CodeBlock>
                </div>
              ) : null}

              {org.domainVerificationStatus === 'active' ? (
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
                        *.{org.customDomain}
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
              onSubmit={(e) => {
                e.preventDefault()
                if (domainInput.trim())
                  setDomainMutation.mutate(domainInput.trim())
              }}
            >
              <Field label="Domain" htmlFor="domain">
                <div className="flex gap-2">
                  <Input
                    id="domain"
                    value={domainInput}
                    onChange={(e) => setDomainInput(e.target.value)}
                    placeholder="acme.dev"
                    className="flex-1"
                  />
                  <Button
                    type="submit"
                    disabled={
                      setDomainMutation.isPending || !domainInput.trim()
                    }
                  >
                    {setDomainMutation.isPending ? 'Setting up…' : 'Set domain'}
                  </Button>
                </div>
              </Field>
            </form>
          )}
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

// Model access (work 011). One Codex subscription per organization, connected
// through the authorized personal-subscription OAuth flow on the dashboard.
function ModelAccessPanel({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient()
  const { data: connections, isLoading } = useQuery({
    queryKey: ['model-access-connections'],
    queryFn: getModelAccessConnections,
  })
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null)

  const invalidate = () =>
    void queryClient.invalidateQueries({
      queryKey: ['model-access-connections'],
    })

  const connectMutation = useMutation({
    mutationFn: () => connectModelAccess({ provider: 'openai' }),
    onSuccess: (result) => {
      window.location.assign(result.authorize_url)
    },
    onError: (e) => notifyError("Couldn't start the Codex connection.", e),
  })

  const disconnectMutation = useMutation({
    mutationFn: (id: string) => disconnectModelAccess(id),
    onSuccess: invalidate,
    onError: (e) => notifyError("Couldn't disconnect the subscription.", e),
  })

  const validateMutation = useMutation({
    mutationFn: (id: string) => validateModelAccessConnection(id),
    onSuccess: invalidate,
    onError: (e) => notifyError("Couldn't validate the connection.", e),
  })

  const codex = connections?.find((c) => c.provider === 'openai')

  return (
    <Panel className="p-6 lg:col-span-2">
      <div className="mb-5">
        <PanelTitle>Model access</PanelTitle>
        <PanelDescription className="mt-1">
          Connect your Codex subscription so eligible model inference is billed
          by your subscription, not OpenComputer credits. Runtime compute is
          still charged. Requires OpenComputer Pro or Max.
        </PanelDescription>
      </div>

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <div className="space-y-6">
          <ModelAccessConnectionRow
            title="Codex subscription"
            connection={codex}
            canManage={canManage}
            onValidate={(id) => validateMutation.mutate(id)}
            onDisconnect={(id) => setConfirmDisconnect(id)}
            validating={validateMutation.isPending}
          />

          {canManage && !codex ? (
            <div className="border-t pt-4">
              <Button
                size="sm"
                disabled={connectMutation.isPending}
                onClick={() => connectMutation.mutate()}
              >
                {connectMutation.isPending
                  ? 'Opening OpenAI…'
                  : 'Connect Codex subscription'}
              </Button>
              <p className="text-muted-foreground mt-2 text-xs">
                You will be redirected to OpenAI to authorize your personal Codex
                subscription. Credentials are never stored in your browser.
              </p>
            </div>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={confirmDisconnect !== null}
        onOpenChange={(open) => !open && setConfirmDisconnect(null)}
        title="Disconnect subscription?"
        description="This revokes the stored credential and returns affected projects to Managed usage-based inference. This cannot be undone."
        confirmLabel="Disconnect"
        onConfirm={() => {
          if (confirmDisconnect) disconnectMutation.mutate(confirmDisconnect)
          setConfirmDisconnect(null)
        }}
      />
    </Panel>
  )
}

function ModelAccessConnectionRow({
  title,
  connection,
  canManage,
  onValidate,
  onDisconnect,
  validating,
}: {
  title: string
  connection: ModelAccessConnection | undefined
  canManage: boolean
  onValidate: (id: string) => void
  onDisconnect: (id: string) => void
  validating: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b pb-4 last:border-0 last:pb-0">
      <div>
        <div className="flex items-center gap-2">
          <span className="font-medium">{title}</span>
          {connection ? (
            <StatusBadge
              status={connection.status === 'connected' ? 'running' : 'pending'}
              label={connection.status.replace(/_/g, ' ')}
            />
          ) : (
            <StatusBadge status="stopped" label="Not connected" />
          )}
        </div>
        {connection ? (
          <p className="text-muted-foreground mt-1 text-sm">
            {connection.label}
            {connection.external_account_hint
              ? ` · ${connection.external_account_hint}`
              : ''}
            {connection.checked_at
              ? ` · checked ${new Date(connection.checked_at).toLocaleDateString()}`
              : ''}
          </p>
        ) : (
          <p className="text-muted-foreground mt-1 text-sm">
            No connection configured.
          </p>
        )}
      </div>
      {connection && canManage ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={validating}
            onClick={() => onValidate(connection.id)}
          >
            Revalidate
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onDisconnect(connection.id)}
          >
            Disconnect
          </Button>
        </div>
      ) : null}
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
