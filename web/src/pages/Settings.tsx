import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  Copy,
  Loader2,
  Mail,
  MoreHorizontal,
  UserPlus,
} from 'lucide-react'
import { notifyError } from '@/lib/errors'
import { useTransientFlag } from '@/lib/use-transient-flag'
import { useAuth } from '@/hooks/useAuth'
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
  type OrgInvitation,
  type OrgMember,
} from '@/api/client'
import { PageHeader } from '@/components/page-header'
import {
  SettingsAction,
  SettingsRow,
  SettingsRowSkeleton,
  SettingsSection,
} from '@/components/settings'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/form'
import { ConfirmDialog } from '@/components/confirm-dialog'
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
import { KnowledgeRepositorySection } from '@/managed-agents/work/KnowledgeRepository'

// The organization's settings, one calm column of sections in the settings
// anatomy (components/settings.tsx): Organization, Knowledge repository
// (with Computer), Members, Agent environment.

export default function Settings() {
  const { user } = useAuth()
  const { data: org } = useQuery({ queryKey: ['org'], queryFn: getOrg })

  return (
    <div className="mx-auto w-full max-w-[720px] pb-16">
      <PageHeader
        title="Settings"
        // The name, once known; a space holds its line until then.
        description={org?.name ?? '\u00a0'}
        className="mb-8"
      />
      <div className="space-y-10">
        <Organization />
        {user?.computerEnabled ? (
          <KnowledgeRepositorySection id="work-repository" />
        ) : null}
        {user?.capabilities?.manageMembers !== false ? <Members /> : null}
        <AgentEnvironment />
      </div>
    </div>
  )
}

function Organization() {
  const queryClient = useQueryClient()
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

  // Local edits override the fetched name; null = "not edited" (avoids an
  // effect to sync the field with the query).
  const [draftName, setDraftName] = useState<string | null>(null)
  const [saved, markSaved] = useTransientFlag(2000)
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

  const loading =
    isLoading || isBillingLoading || (usesAutumnBilling && isAutumnLoading)
  const changed = name.trim() !== '' && name !== (org?.name ?? '')

  return (
    <SettingsSection
      title="Organization"
      description="Your organization's name and plan."
    >
      {loading ? (
        <div role="status" aria-label="Loading" className="divide-y">
          <SettingsRowSkeleton />
          <SettingsRowSkeleton />
          <SettingsRowSkeleton />
        </div>
      ) : (
        <>
          <SettingsRow
            label="Name"
            htmlFor="org-name"
            action={
              changed || saveMutation.isPending ? (
                <>
                  <SettingsAction
                    type="button"
                    onClick={() => setDraftName(null)}
                    disabled={saveMutation.isPending}
                  >
                    Cancel
                  </SettingsAction>
                  <Button
                    type="submit"
                    form="org-name-form"
                    size="sm"
                    disabled={saveMutation.isPending}
                  >
                    {saveMutation.isPending ? (
                      <Loader2 className="animate-spin" aria-hidden />
                    ) : null}
                    Save
                  </Button>
                </>
              ) : saved ? (
                <span className="text-muted-foreground inline-flex items-center gap-1.5 px-2.5">
                  <Check className="size-3.5" aria-hidden />
                  Saved
                </span>
              ) : null
            }
          >
            <form
              id="org-name-form"
              onSubmit={(e) => {
                e.preventDefault()
                if (changed) saveMutation.mutate(name)
              }}
            >
              <Input
                id="org-name"
                value={name}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setDraftName(null)}
                className="max-w-80"
                autoComplete="off"
              />
            </form>
          </SettingsRow>
          <SettingsRow
            label="Plan"
            action={
              <SettingsAction asChild>
                <Link to="/billing">Manage billing</Link>
              </SettingsAction>
            }
          >
            <span className="font-medium">
              {organizationPlanLabel(org, billing, autumn)}
            </span>
          </SettingsRow>
          <SettingsRow
            label="Organization ID"
            action={org?.id ? <CopyButton value={org.id} /> : null}
          >
            <code className="block truncate font-mono text-[13px] [font-variant-ligatures:none]">
              {org?.id ?? '—'}
            </code>
          </SettingsRow>
        </>
      )}
    </SettingsSection>
  )
}

/** Copy, then "Copied" with a check for a moment once the clipboard has it. */
function CopyButton({ value }: { value: string }) {
  const [copied, markCopied] = useTransientFlag(1500)
  return (
    <SettingsAction
      type="button"
      onClick={() =>
        void navigator.clipboard
          .writeText(value)
          .then(markCopied, (e) =>
            notifyError("Couldn't copy to clipboard.", e),
          )
      }
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? 'Copied' : 'Copy'}
    </SettingsAction>
  )
}

/** The people in the organization, then the invitations still pending. */
function Members() {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const members = useQuery({
    queryKey: ['org-members'],
    queryFn: getOrgMembers,
  })
  const invitations = useQuery({
    queryKey: ['org-invitations'],
    queryFn: getInvitations,
  })

  const [showInvite, setShowInvite] = useState(false)
  const [toRemove, setToRemove] = useState<OrgMember | null>(null)
  const [toRevoke, setToRevoke] = useState<OrgInvitation | null>(null)

  const inviteMutation = useMutation({
    mutationFn: (email: string) => sendInvitation(email),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['org-members'] })
      void queryClient.invalidateQueries({ queryKey: ['org-invitations'] })
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

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeInvitation(id),
    onError: (e) => notifyError("Couldn't revoke the invitation.", e),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: ['org-invitations'] }),
  })

  const pending = (invitations.data ?? []).filter(
    (inv) => inv.state === 'pending',
  )
  const isMe = (m: OrgMember) =>
    !!user &&
    (m.id === user.id || m.email.toLowerCase() === user.email.toLowerCase())

  return (
    <SettingsSection
      title="Members"
      description="People with access to this organization."
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowInvite((v) => !v)}
          aria-expanded={showInvite}
        >
          <UserPlus aria-hidden />
          Invite
        </Button>
      }
    >
      {showInvite ? (
        <InviteRow
          sending={inviteMutation.isPending}
          onSend={(email) => inviteMutation.mutate(email)}
          onCancel={() => setShowInvite(false)}
        />
      ) : null}

      {members.isLoading ? (
        <div role="status" aria-label="Loading" className="divide-y">
          <PersonSkeleton />
          <PersonSkeleton />
        </div>
      ) : members.isError ? (
        <SettingsRow>
          <span className="text-muted-foreground">
            Could not load the members. Try loading this page again.
          </span>
        </SettingsRow>
      ) : (members.data ?? []).length === 0 ? (
        <SettingsRow>
          <span className="text-muted-foreground">No members yet.</span>
        </SettingsRow>
      ) : (
        (members.data ?? []).map((member, i) => {
          const me = isMe(member)
          return (
            <PersonRow
              key={member.membershipId || member.id || i}
              initials={initials(member.name || member.email)}
              primary={member.name || member.email}
              tag={me ? 'You' : undefined}
              secondary={
                member.name && member.name !== member.email
                  ? member.email
                  : null
              }
              role={member.role}
              menu={
                member.membershipId && !me ? (
                  <RowMenu
                    label={`Actions for ${member.email}`}
                    item="Remove from organization"
                    onSelect={() => setToRemove(member)}
                  />
                ) : null
              }
            />
          )
        })
      )}

      {pending.map((inv) => (
        <PersonRow
          key={inv.id}
          invited
          primary={inv.email}
          tag="Invited"
          secondary={`Expires ${new Date(inv.expiresAt).toLocaleDateString(
            undefined,
            { month: 'short', day: 'numeric' },
          )}`}
          role={inv.role ?? 'member'}
          menu={
            <RowMenu
              label={`Actions for the invitation to ${inv.email}`}
              item="Revoke invitation"
              onSelect={() => setToRevoke(inv)}
            />
          }
        />
      ))}

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
    </SettingsSection>
  )
}

/** The email to invite, focused as it opens; Escape or Cancel closes it. */
function InviteRow({
  sending,
  onSend,
  onCancel,
}: {
  sending: boolean
  onSend: (email: string) => void
  onCancel: () => void
}) {
  const [email, setEmail] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  return (
    <SettingsRow
      label="Invite by email"
      htmlFor="invite-email"
      action={
        <>
          <SettingsAction type="button" onClick={onCancel}>
            Cancel
          </SettingsAction>
          <Button
            type="submit"
            form="invite-form"
            size="sm"
            disabled={sending || !email.trim()}
          >
            {sending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Send invite
          </Button>
        </>
      }
    >
      <form
        id="invite-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (email.trim()) onSend(email.trim())
        }}
      >
        <Input
          ref={input}
          id="invite-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onCancel()}
          placeholder="name@example.com"
          className="max-w-80"
        />
      </form>
    </SettingsRow>
  )
}

function initials(s: string) {
  const words = s.split(/[\s@._-]+/).filter(Boolean)
  const letters =
    words.length > 1 && !s.includes('@')
      ? words[0][0] + words[1][0]
      : (words[0]?.[0] ?? '?')
  return letters.toUpperCase()
}

/**
 * A member or an invitation: the avatar on the label's edge, name over
 * email, the role in a column of its own so roles line up, and the menu in
 * the trailing column. On a phone the role goes beside the email.
 */
function PersonRow({
  initials: letters,
  invited = false,
  primary,
  tag,
  secondary,
  role,
  menu,
}: {
  initials?: string
  invited?: boolean
  primary: string
  /** A small tag after the name ("You", "Invited"). */
  tag?: string
  secondary: string | null
  role: string
  menu: ReactNode
}) {
  return (
    <SettingsRow
      className="min-h-15"
      // A slot the menu's size even without one, so the roles line up.
      action={menu ?? <span className="size-7" />}
    >
      <div className="flex items-center gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {invited ? (
            <span className="text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed">
              <Mail className="size-3.5" aria-hidden />
            </span>
          ) : (
            <span
              className="bg-secondary text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium"
              aria-hidden
            >
              {letters}
            </span>
          )}
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-medium">{primary}</span>
              {tag ? (
                <span className="text-muted-foreground shrink-0 rounded-sm border px-1 text-xs leading-4">
                  {tag}
                </span>
              ) : null}
            </div>
            {/* On a phone the role joins this line, so every row is two. */}
            <div className="text-muted-foreground truncate text-xs">
              {secondary}
              <span className="sm:hidden">
                {secondary ? ' · ' : null}
                <span className="capitalize">{role}</span>
              </span>
            </div>
          </div>
        </div>
        <span className="text-muted-foreground hidden w-20 shrink-0 capitalize sm:block">
          {role}
        </span>
      </div>
    </SettingsRow>
  )
}

/** The quiet "…" menu of a member or invitation row, with its one action. */
function RowMenu({
  label,
  item,
  onSelect,
}: {
  label: string
  item: string
  onSelect: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SettingsAction size="icon-sm" aria-label={label}>
          <MoreHorizontal />
        </SettingsAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          variant="destructive"
          className="whitespace-nowrap"
          onSelect={onSelect}
        >
          {item}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PersonSkeleton() {
  return (
    <SettingsRow className="min-h-15">
      <div className="flex items-center gap-3">
        <Skeleton className="size-8 shrink-0 rounded-full" />
        <div className="space-y-1.5">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
    </SettingsRow>
  )
}

/** The VM package image agents start with (custom images are Enterprise). */
function AgentEnvironment() {
  const [showInfo, setShowInfo] = useState(false)
  const profile = useQuery({
    queryKey: ['managed-runtime-profile'],
    queryFn: getManagedRuntimeProfile,
    retry: false,
  })

  return (
    <SettingsSection
      title="Agent environment"
      description="The tools available to agents when they start a VM."
    >
      <SettingsRow
        label="Package image"
        action={
          <SettingsAction onClick={() => setShowInfo(true)}>
            Edit
          </SettingsAction>
        }
      >
        {profile.isLoading ? (
          <Skeleton className="h-3.5 w-40" />
        ) : (
          <>
            <div className="font-medium">
              {profile.isError
                ? 'Unavailable'
                : (profile.data?.displayName ?? 'OpenComputer default')}
            </div>
            {profile.data?.customized ? (
              <div className="text-muted-foreground text-xs">
                A dedicated image is assigned to this organization.
              </div>
            ) : null}
          </>
        )}
      </SettingsRow>

      <Dialog open={showInfo} onOpenChange={setShowInfo}>
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
    </SettingsSection>
  )
}
