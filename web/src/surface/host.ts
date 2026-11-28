import type { Channel, Principal, UploadRequest } from '@opencomputer/sdk/computer'

// What the surface is given by whatever it runs in (spec section 25). The web
// tab and the Mac app differ only behind this.

export type Location = {
  thread: string | null
  track: string | null
  // The result open over the main area (S9, S10).
  result: string | null
  // The start box (S5).
  start: boolean
}

export interface Host {
  platform: 'web' | 'desktop'
  principal: Principal
  // The person's name, where the host knows it.
  name?: string
  api: {
    fetch(path: string, init?: RequestInit): Promise<Response>
    // An attachment's bytes to their signed URL, with progress (work 126, K3):
    // XMLHttpRequest in a browser, where `fetch` reports none. `url` is
    // absolute, on whatever host the server named, and is its own authority:
    // no credential goes with it. Without this the client uses `fetch`.
    uploadTo?(url: string, req: UploadRequest): Promise<Response>
  }
  connect(): Channel
  notify(n: {
    threadId: string
    askId?: string
    title: string
    body: string
    choices?: { id: string; label: string }[]
  }): void
  badge(count: number): void
  openExternal(url: string): void
  // Where the person adds credits, where the host has such a page.
  billing?: string
  onOpen(
    cb: (target: {
      threadId?: string
      trackId?: string
      askId?: string
      // The hotkey and File > New Thread: the start box.
      new?: boolean
    }) => void,
  ): void
  // A button pressed on a permission's notification (desktop only).
  onAnswer?(
    cb: (a: { threadId: string; askId: string; choice: string }) => void,
  ): void
  backup?: {
    read(what: 'queue' | 'drafts'): Promise<Uint8Array | null>
    write(what: 'queue' | 'drafts', v: Uint8Array): Promise<void>
  }
  // The address of a thread or track to paste elsewhere: the web tab's URL,
  // which opens only for someone who could open it anyway. None in the Mac
  // app, whose addresses are its own.
  link?(loc: Location): string
  // Where the host keeps what is open: the URL on the web.
  location: {
    get(): Location
    set(loc: Location, o?: { replace?: boolean }): void
    onChange(cb: (loc: Location) => void): () => void
  }
}

export const NOWHERE: Location = {
  thread: null,
  track: null,
  result: null,
  start: false,
}
