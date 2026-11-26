// Deep links (spec section 24.2): parsed here into a closed set, ids matched
// against their format (section 34.1). A link only navigates; it never
// carries text, and never a sign-in code.
import type { OpenTarget } from '../shared/bridge'

const ID = '[0-9A-HJKMNP-TV-Z]' // Crockford base32
const SESSION = new RegExp(`^cs_${ID}{16}$`, 'i')
const TRACK = new RegExp(`^trk_${ID}{16}$`, 'i')
const ASK = new RegExp(`^ak_${ID}{12}$`, 'i')

export function parseDeepLink(link: string): OpenTarget | null {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  if (url.protocol !== 'opencomputer:' || url.username || url.password || url.port || url.hash) return null
  const parts = [url.hostname, ...url.pathname.split('/').filter(Boolean)]
  const [kind, id, ...rest] = parts
  if (rest.length) return null
  if (kind === 'new' && !id && !url.search) return { new: true }
  if (kind === 'thread' && id && SESSION.test(id)) {
    const ask = url.searchParams.get('ask')
    if ([...url.searchParams.keys()].some((k) => k !== 'ask')) return null
    if (ask !== null && !ASK.test(ask)) return null
    return ask ? { threadId: id, askId: ask } : { threadId: id }
  }
  if (kind === 'track' && id && TRACK.test(id) && !url.search) return { trackId: id }
  return null
}

/** The target that reopens a location the surface mirrored (`/t/<thread>`, `/k/<track>`, `/new`). */
export function locationTarget(path: string): OpenTarget | null {
  const [, kind, id] = path.split('?')[0]!.split('/')
  if (kind === 't' && id && SESSION.test(id)) return { threadId: id }
  if (kind === 'k' && id && TRACK.test(id)) return { trackId: id }
  if (kind === 'new' && !id) return { new: true }
  return null
}
