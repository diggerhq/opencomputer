// A sandbox in `stopped` is terminal: its VM has been destroyed (by the user,
// an idle/duration timeout, or the platform) and it can never be resumed —
// unlike `hibernated`. The dashboard calls that "Deleted" so it isn't read as
// a resumable pause.
export function sandboxStatusLabel(status: string): string | undefined {
  return status === 'stopped' ? 'Deleted' : undefined
}
