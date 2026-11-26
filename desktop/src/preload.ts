// The one preload script (spec sections 24.2, 42.3). Sandboxed; exposes
// `window.oc` and nothing else of Electron or Node.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_PRINCIPAL, IPC_TO_MAIN, IPC_TO_PAGE, type MainToPage, type OcBridge, type PageToMain } from './shared/bridge'

const listeners = new Set<(msg: MainToPage) => void>()
// Messages from the main process can arrive before the page's script has
// subscribed; they wait here for the first listener.
let early: MainToPage[] | null = []

ipcRenderer.on(IPC_TO_PAGE, (_event, msg: MainToPage) => {
  if (early) early.push(msg)
  else for (const cb of listeners) cb(msg)
})

const bridge: OcBridge = {
  send(msg: PageToMain) {
    ipcRenderer.send(IPC_TO_MAIN, msg)
  },
  on(cb) {
    listeners.add(cb)
    if (early) {
      const waiting = early
      early = null
      for (const msg of waiting) cb(msg)
    }
    return () => listeners.delete(cb)
  },
  host: { platform: 'desktop', principal: ipcRenderer.sendSync(IPC_PRINCIPAL) ?? null },
}

contextBridge.exposeInMainWorld('oc', bridge)
