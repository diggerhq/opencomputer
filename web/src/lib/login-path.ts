// Server-owned login route carrying the URL to land on after the round-trip
// (the edge threads it through the WorkOS `state`).
export function loginPathForReturn(returnTo: string) {
  return returnTo === '/'
    ? '/auth/login'
    : `/auth/login?returnTo=${encodeURIComponent(returnTo)}`
}
