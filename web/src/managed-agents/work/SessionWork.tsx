import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getSessionItems, useOrg, workKeys } from './api'

// How many items the session header names; the rest are a count.
const SHOWN = 2

/**
 * The tracked items a session worked on (its commits' `Session:` trailers),
 * as quiet chips in the session's header, each linking to the item. Nothing
 * while loading, on any error (no repository, Work unavailable) or when the
 * session named no item.
 */
export function SessionWork({ id }: { id: string }) {
  const org = useOrg()
  const { data: items } = useQuery({
    queryKey: workKeys.session(org, id),
    queryFn: () => getSessionItems(id),
    retry: false,
    staleTime: 60_000,
  })
  if (!items?.length) return null
  const more = items.length - SHOWN
  return (
    <span className="flex min-w-0 shrink items-center gap-1.5">
      {items.slice(0, SHOWN).map((item) => (
        <Link
          key={item.number}
          to={`/computer/work/${item.number}`}
          title={`Work item ${item.number}: ${item.title}`}
          className="text-muted-foreground hover:text-foreground hover:border-foreground/25 inline-flex h-5 max-w-56 min-w-0 items-center gap-1 rounded-sm border px-1.5 text-xs transition-colors"
        >
          <span className="shrink-0">Work:</span>
          <span className="shrink-0 tabular-nums">{item.number}</span>
          <span className="truncate">{item.title}</span>
        </Link>
      ))}
      {more > 0 ? (
        <span
          className="text-muted-foreground shrink-0 text-xs"
          title={items
            .slice(SHOWN)
            .map((i) => `${i.number} ${i.title}`)
            .join('\n')}
        >
          +{more}
        </span>
      ) : null}
    </span>
  )
}
