import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getOrgMembers } from '@/api/client'
import { ApiError } from '@/api/errors'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Select } from '@/components/form'
import {
  SettingsRow,
  SettingsRowSkeleton,
  SettingsSection,
} from '@/components/settings'
import { useAuth } from '@/hooks/useAuth'
import { notifyError } from '@/lib/errors'
import {
  getOrganizationSettings,
  sessionKeys,
  updateOrganizationSettings,
  type OrganizationSettings,
} from '../computer-sessions-api'
import { isAdminRole } from './members'

type Default = OrganizationSettings['apiAccessDefault']

const OPTIONS: { value: Default; label: string }[] = [
  { value: 'owner', label: 'Only its owner' },
  { value: 'org', label: 'Whole organization' },
]

/**
 * Who can see and drive a new session started from the web, opc or the API
 * when it asks for nothing else (`apiAccessDefault`). Slack sessions keep
 * their own default. Admins change it; members see it.
 */
export function SessionAccessDefaultSection({ id }: { id?: string }) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const settings = useQuery({
    queryKey: sessionKeys.orgSettings,
    queryFn: getOrganizationSettings,
    retry: false,
  })
  const members = useQuery({
    queryKey: ['org-members'],
    queryFn: getOrgMembers,
    staleTime: 5 * 60_000,
  })
  const admin = !!members.data?.some(
    (m) => m.email === user?.email && isAdminRole(m.role),
  )
  const [confirming, setConfirming] = useState(false)
  const save = useMutation({
    mutationFn: (apiAccessDefault: Default) =>
      updateOrganizationSettings({ apiAccessDefault }),
    onSuccess: (next) => {
      qc.setQueryData(sessionKeys.orgSettings, next)
      setConfirming(false)
    },
    onError: (e) => notifyError("Couldn't change the default access.", e),
  })

  // Not on this backend yet: nothing to set.
  if (settings.error instanceof ApiError && settings.error.status === 404)
    return null

  const value = settings.data?.apiAccessDefault
  return (
    <SettingsSection
      id={id}
      title="Session access"
      description="Who can see and drive a new session started from the web, opc or the API. Slack sessions keep their own default. Each session's owner can change it."
    >
      {settings.isPending ? (
        <div role="status" aria-label="Loading" className="divide-y">
          <SettingsRowSkeleton />
        </div>
      ) : settings.isError || !value ? (
        <SettingsRow>
          <span className="text-muted-foreground">
            Could not load the default access. Try loading this page again.
          </span>
        </SettingsRow>
      ) : (
        <SettingsRow label="Default access" htmlFor="api-access-default">
          {admin ? (
            <Select
              id="api-access-default"
              value={value}
              onValueChange={(next) => {
                if (next === value) return
                if (next === 'org') setConfirming(true)
                else save.mutate(next as Default)
              }}
              options={OPTIONS}
              disabled={save.isPending}
              className="w-56"
            />
          ) : (
            <span>
              {OPTIONS.find((o) => o.value === value)?.label}
              <span className="text-muted-foreground">
                {' '}
                · admins change this
              </span>
            </span>
          )}
        </SettingsRow>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Share new sessions with the whole organization?"
        description="Every member will be able to see and drive new sessions from the web, opc and the API, and run them as their owner: with the owner's secrets, connections and model subscription. Existing sessions keep their access."
        confirmLabel="Share by default"
        pending={save.isPending}
        onConfirm={() => save.mutate('org')}
      />
    </SettingsSection>
  )
}
