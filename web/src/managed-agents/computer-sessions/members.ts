import { useQuery } from '@tanstack/react-query'
import { getOrgMembers } from '@/api/client'
import type { OrgMember } from '@/api/schemas'
import { getComputerMe, sessionKeys } from '../computer-sessions-api'

// The member ids (`usr_…`) the computer knows an organization member by. It
// derives one from the user id: the WorkOS id when there is one, else a hash
// (`memberId` in managed-agents). Either may be the one a session names.
async function memberIds(m: OrgMember): Promise<string[]> {
  const ids: string[] = []
  const workos = /^user_(\w+)$/.exec(m.workosUserId ?? '')
  if (workos) ids.push(`usr_${workos[1].toLowerCase()}`)
  if (m.id) {
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m.id)),
    )
    const hex = [...digest.slice(0, 13)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    ids.push(`usr_x${hex}`)
  }
  return ids
}

/** An organization member as a session's access names them. */
export interface OrgPerson {
  /** The member id to send (the WorkOS-derived one when there is one). */
  id: string
  /** Every id they may appear under. */
  ids: string[]
  email: string
  name: string
  admin: boolean
}

export const isAdminRole = (role: string) =>
  role === 'admin' || role === 'owner'

export async function orgPeople(members: OrgMember[]): Promise<OrgPerson[]> {
  const people: OrgPerson[] = []
  for (const m of members) {
    const ids = await memberIds(m)
    if (!ids.length) continue
    people.push({
      id: ids[0],
      ids,
      email: m.email,
      name: m.name,
      admin: isAdminRole(m.role),
    })
  }
  return people
}

function useOrgMembers() {
  return useQuery({
    queryKey: ['org-members'],
    queryFn: getOrgMembers,
    staleTime: 5 * 60_000,
  })
}

export function useOrgPeople(): OrgPerson[] | undefined {
  const { data: members } = useOrgMembers()
  const { data } = useQuery({
    queryKey: ['org-members', 'people', members],
    queryFn: () => orgPeople(members ?? []),
    enabled: !!members,
    staleTime: Infinity,
  })
  return data
}

// Members' emails by member id.
export function useMemberEmails(): Map<string, string> | undefined {
  const people = useOrgPeople()
  if (!people) return undefined
  const emails = new Map<string, string>()
  for (const p of people) for (const id of p.ids) emails.set(id, p.email)
  return emails
}

/** The caller's own member id (`usr_…`), as sessions name people. */
export function useMyMemberId(): string | undefined {
  const { data } = useQuery({
    queryKey: sessionKeys.me,
    queryFn: getComputerMe,
    staleTime: Infinity,
  })
  return data?.id
}
