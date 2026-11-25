// Where the edge is. Compiled in by build.mjs; an unpackaged run (development,
// tests) may point elsewhere with OC_EDGE_URL. A packaged app reads no
// environment, since whoever sets it would receive the token.
declare const __OC_EDGE__: string
declare const __OC_UI_KEY__: string
declare const __OC_UPDATE_URL__: string

export function edgeUrl(isPackaged: boolean): string {
  const url = (!isPackaged && process.env.OC_EDGE_URL) || __OC_EDGE__
  return url.replace(/\/+$/, '')
}

/** The public routes' prefix on the edge (spec section 34.2); `GET /live` is under it (section 38). */
export const COMPUTER_API_PREFIX = '/api/managed-agents/computer'
export const LIVE_PATH = `${COMPUTER_API_PREFIX}/live`

/** Ed25519 public key (PEM) that signs a fetched UI bundle's manifest; empty: fetched bundles are never used. */
export const UI_BUNDLE_KEY: string = __OC_UI_KEY__
export const UPDATE_URL: string = __OC_UPDATE_URL__

/** S11's system-wide hotkey. */
export const START_HOTKEY = 'CommandOrControl+Shift+Space'
