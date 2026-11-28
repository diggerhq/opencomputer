import type { ApiEvent, Pending, PendingAttachment, Storage } from '@opencomputer/sdk/computer'
import type { Host, Location } from '../host'
import type { Refusal } from './pulls'
import type { Rows } from './rows'
import type { OpenBlock } from './transcript'
import type { Counts } from './views'

// What the surface's store holds (spec 26.2): what the server last said, the
// person's unconfirmed writes replayed on top, and what is open on screen.

export type Layout = 'L1' | 'L2' | 'L3'
export type TrackTab = 'activity' | 'threads' | 'doc' | 'results'
export type Theme = 'system' | 'light' | 'dark'

export interface Toast {
  id: string
  text: string
  tone?: 'error'
  undo?: () => void
  // A way on from an error: "Add credits" on an out-of-credits refusal.
  action?: { label: string; run: () => void }
}

export interface Convo {
  events: ApiEvent[]
  // The first page has arrived (from storage or the server).
  loaded: boolean
  // Text still streaming; never stored (spec 26.4).
  open: OpenBlock | null
}

// What is kept across reloads, beside the rows.
export interface Kept {
  loc: Location
  layout: Record<string, Layout>
  trackTab: Record<string, TrackTab>
  listHidden: boolean
  openTracks: Record<string, boolean>
  earlierOpen: boolean
  trackEarlierOpen: Record<string, boolean>
  drafts: Record<string, string>
  // The files attached in each composer, by draft key (work 126): ids of the
  // client's pending attachments. After a reload the ones it no longer holds
  // are dropped; the bytes do not survive one, so an unfinished upload is failed.
  draftAttachments: Record<string, string[]>
  // The session the start box's attachments were uploaded to (D8): made when
  // its first file is attached, and the one `start` then creates.
  startSession: string | null
  theme: Theme
  reviewMode: 'summary' | 'full'
}

export interface State extends Kept {
  me: string
  // Storage has been read: what was seen before is on screen (R43).
  ready: boolean
  // The server has answered since this page opened.
  synced: boolean
  status: 'connecting' | 'online' | 'offline'
  // The feed's rows, then those with Earlier's pages beneath and pending writes on top.
  base: Rows
  rows: Rows
  pending: Pending[]
  // Every file attached and not yet sent, with its upload's progress.
  attachments: PendingAttachment[]
  // The deployment has a store for files (the capabilities' `features.attachments`);
  // true until the server says otherwise. False: no paperclip, and a dropped
  // or pasted file is ignored.
  canAttach: boolean
  counts: Counts
  convos: Record<string, Convo>
  toasts: Toast[]
  // Why a result's pull request was not merged, and at which head: read with `refusalOf`, which drops it once the pull request moves (work 118).
  unmerged: Record<string, Refusal>
  palette: boolean
  keysSheet: boolean
  earlierNext: Record<string, string | null | undefined>
  // Threads a link named that the server does not have (spec 26.2): shown as not found.
  missing: Record<string, true>
  // Threads a link named whose read failed otherwise (forbidden, server error):
  // shown as not opened, with Try again.
  unopened: Record<string, true>
}

export const KEPT: (keyof Kept)[] = [
  'loc',
  'layout',
  'trackTab',
  'listHidden',
  'openTracks',
  'earlierOpen',
  'trackEarlierOpen',
  'drafts',
  'draftAttachments',
  'startSession',
  'theme',
  'reviewMode',
]

export const NO_COUNTS: Counts = { earlier: 0, trackEarlier: {} }
export const EMPTY_CONVO: Convo = { events: [], loaded: false, open: null }

export interface SurfaceOptions {
  host: Host
  storage: Storage
  // Where UI state is kept; localStorage in a browser.
  kept?: { get(): string | null; set(v: string): void }
  visible?: () => boolean
  // Calls back when the network may be back: the browser is online again, or
  // the tab is shown. Default: those two events of the page.
  wake?: (cb: () => void) => () => void
}
