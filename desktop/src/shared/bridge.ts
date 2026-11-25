// The shell's bridge (spec section 42.3): every message that crosses between a
// page on oc://app/ and the main process. The preload carries them unchanged;
// the page-side Host (src/host) and the main process (src/main/ipc.ts) are the
// only two places that make or read them.

export type Principal = { org: string; subject: string }

export type OpenTarget = { threadId?: string; trackId?: string; askId?: string; new?: boolean }

export type Notice = {
  threadId: string
  askId?: string
  title: string
  body: string
  choices?: { id: string; label: string }[]
}

export type BackupKind = 'queue' | 'drafts'

/** A socket frame. The main process reads `t`, `stream` and `session` to route, nothing else. */
export type Frame = { t: string; stream?: string; session?: string; [k: string]: unknown }

export type PageToMain =
  | { t: 'chan.send'; frame: Frame }
  | { t: 'subs'; streams: string[] }
  | { t: 'backup.write'; what: BackupKind; data: Uint8Array }
  | { t: 'backup.read'; what: BackupKind; id: string }
  | { t: 'open.external'; url: string }
  | { t: 'location'; path: string }
  | { t: 'badge'; count: number }
  | { t: 'notify'; n: Notice }
  // Not in the spec's table (build log, lane 5): the start panel hands a
  // target to the main window, the panel asks to be hidden, and the sign-in
  // page and the surface start and end a sign-in.
  | { t: 'open'; target: OpenTarget }
  | { t: 'panel.hide' }
  | { t: 'signin' }
  | { t: 'signout' }

export type MainToPage =
  | { t: 'chan.frame'; frame: Frame }
  | { t: 'chan.state'; state: 'open' | 'closed' }
  | { t: 'backup.data'; id: string; data: Uint8Array | null }
  | { t: 'open'; target: OpenTarget }
  | { t: 'answer'; threadId: string; askId: string; choice: string }
  | { t: 'principal'; principal: Principal }
  | { t: 'signed-out' }
  // Not in the spec's table: the start panel was shown (focus the box), and a
  // sign-in failed (the sign-in page shows why).
  | { t: 'panel.shown' }
  | { t: 'signin.error'; message: string }

/** What the preload exposes as `window.oc`. */
export interface OcBridge {
  send(msg: PageToMain): void
  /** Messages that arrived before the first listener are delivered to it. Returns an unsubscribe. */
  on(cb: (msg: MainToPage) => void): () => void
  host: { platform: 'desktop'; principal: Principal | null }
}

export const IPC_TO_MAIN = 'oc:to-main'
export const IPC_TO_PAGE = 'oc:to-page'
export const IPC_PRINCIPAL = 'oc:principal'

/** The origin every app page lives on, and the header the API proxy demands (section 24.2). */
export const APP_ORIGIN = 'oc://app'
export const APP_HEADER = 'x-oc-app'
