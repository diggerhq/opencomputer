import { Navigate, useParams } from 'react-router-dom'

/**
 * The old session pages' links (`/computer/sessions…`, which opc prints) open
 * the same place on the work surface: a session is a thread there.
 */
export default function OldSessionRedirect() {
  const rest = useParams()['*'] ?? ''
  const id = rest.split('/')[0] ?? ''
  const to = !id
    ? '/computer/work'
    : id === 'new'
      ? '/computer/work/new'
      : `/computer/work/t/${encodeURIComponent(id)}`
  return <Navigate to={to} replace />
}
