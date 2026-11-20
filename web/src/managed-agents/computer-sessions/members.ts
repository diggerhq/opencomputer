import { useQuery } from '@tanstack/react-query'
import { getOrgMembers } from '@/api/client'
import type { OrgMember } from '@/api/schemas'

// Members' emails by member id (`usr_…`). The computer derives that id from the
// user id: the WorkOS id when there is one, else a hash (`memberId` in managed-agents).
async function memberEmails(
  members: OrgMember[],
): Promise<Map<string, string>> {
  const emails = new Map<string, string>()
  for (const m of members) {
    const workos = /^user_(\w+)$/.exec(m.workosUserId ?? '')
    if (workos) emails.set(`usr_${workos[1].toLowerCase()}`, m.email)
    if (!m.id) continue
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m.id)),
    )
    const hex = [...digest.slice(0, 13)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    emails.set(`usr_x${hex}`, m.email)
  }
  return emails
}

export function useMemberEmails(): Map<string, string> | undefined {
  const { data: members } = useQuery({
    queryKey: ['org-members'],
    queryFn: getOrgMembers,
    staleTime: 5 * 60_000,
  })
  const { data } = useQuery({
    queryKey: ['org-members', 'emails', members],
    queryFn: () => memberEmails(members ?? []),
    enabled: !!members,
    staleTime: Infinity,
  })
  return data
}
