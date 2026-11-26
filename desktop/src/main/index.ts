// The main process of the Mac app (spec section 24). It owns what a page must
// not: the token, the socket, the windows, the notifications. Everything a
// page can ask of it arrives as one of the bridge's messages (section 42.3).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  net,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  shell,
  type IpcMainEvent,
  type Session,
  type WebContents,
} from 'electron'
import { APP_ORIGIN, IPC_PRINCIPAL, IPC_TO_MAIN, IPC_TO_PAGE, type Frame, type MainToPage, type Notice, type OpenTarget, type PageToMain } from '../shared/bridge'
import { Auth } from './auth'
import { builtinVersion, chooseBundle, fetchBundle } from './bundle'
import { edgeUrl, LIVE_PATH, START_HOTKEY, UI_BUNDLE_KEY } from './config'
import { locationTarget, parseDeepLink } from './deeplink'
import { Router } from './router'
import { createHandler } from './scheme'
import { LiveSocket } from './socket'
import { startUpdates } from './updates'

const APP = `${APP_ORIGIN}/`
const SIGN_IN = `${APP}__shell/signin.html`
const PARTITION = 'persist:app'

protocol.registerSchemesAsPrivileged([
  { scheme: 'oc', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
])

// One instance: a second launch (a deep link on Windows and Linux) goes to the first.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void main()
}

async function main(): Promise<void> {
  // A link that arrives before the window exists waits here.
  let pendingOpen: OpenTarget | null = null
  let deliverOpen: (target: OpenTarget) => void = (target) => (pendingOpen = target)
  app.on('open-url', (event, url) => {
    event.preventDefault()
    const target = parseDeepLink(url)
    if (target) deliverOpen(target)
  })
  app.on('second-instance', (_event, argv) => {
    const target = argv.map(parseDeepLink).find(Boolean)
    deliverOpen(target ?? {})
  })
  app.setAsDefaultProtocolClient('opencomputer')

  await app.whenReady()

  // A development run on a Linux machine without a key store (CI under xvfb).
  if (!app.isPackaged && process.platform === 'linux' && process.env.OC_PLAIN_KEY_STORE) safeStorage.setUsePlainTextEncryption(true)

  const edge = edgeUrl(app.isPackaged)
  const userData = app.getPath('userData')
  const credentialFile = join(userData, 'credential.bin')
  const stateFile = join(userData, 'window-state.json')
  const backupRoot = join(userData, 'backup')

  const auth = new Auth({
    edge,
    deviceName: hostname(),
    fetch: (input, init) => net.fetch(input as string, init),
    openExternal: (url) => shell.openExternal(url),
    load: () => (existsSync(credentialFile) ? readFileSync(credentialFile) : null),
    save: (sealed) => {
      if (sealed === null) rmSync(credentialFile, { force: true })
      else if (sealed.length) writeFileSync(credentialFile, sealed, { mode: 0o600 })
    },
    // Without a key store the refresh token is not written at all: the
    // person signs in again at next launch.
    seal: (plain) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain) : Buffer.alloc(0)),
    unseal: (sealed) => safeStorage.decryptString(sealed),
  })

  // ---- The UI bundle and the oc://app/ handler ----

  const packagedUi = join(app.getAppPath(), 'ui')
  const placeholder = join(app.getAppPath(), 'dist', 'placeholder')
  // The shell's own tests exercise the bridge through the placeholder page.
  const builtin = (app.isPackaged || process.env.OC_UI !== 'placeholder') && existsSync(join(packagedUi, 'index.html')) ? packagedUi : placeholder
  const uiRoot = join(userData, 'ui')
  mkdirSync(uiRoot, { recursive: true })
  const bundle = chooseBundle(uiRoot, builtin, builtinVersion(builtin), UI_BUNDLE_KEY)
  setTimeout(() => {
    fetchBundle({ root: uiRoot, base: `${edge}/desktop/ui`, keyPem: UI_BUNDLE_KEY, newerThan: bundle.version, fetch: (i, init) => net.fetch(i as string, init) }).catch(() => {
      // Used at next launch if it arrives; the copy in hand keeps serving.
    })
  }, 10_000)

  const ses: Session = session.fromPartition(PARTITION)
  ses.protocol.handle(
    'oc',
    createHandler({
      edge,
      uiDir: () => bundle.dir,
      shellDir: join(app.getAppPath(), 'dist', 'shell'),
      signedIn: () => auth.principal !== null,
      token: () => auth.token(),
      invalidate: (t) => auth.invalidate(t),
      fetch: (input, init) => net.fetch(input as string, init),
    }),
  )
  // The app asks for no permission through a page: notifications are the
  // main process's. Copying text is the one thing a page may do.
  const allowed = (permission: string, origin: string) => permission === 'clipboard-sanitized-write' && origin.startsWith(APP_ORIGIN)
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(allowed(permission, wc?.getURL() ?? '')))
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowed(permission, origin))

  // ---- Navigation is fenced (section 24.2), for every web contents there will ever be ----

  app.on('web-contents-created', (_event, wc) => {
    const stay = (event: { preventDefault(): void }, url: string) => {
      if (!url.startsWith(APP)) event.preventDefault()
    }
    wc.on('will-navigate', stay)
    wc.on('will-redirect', stay)
    wc.on('will-attach-webview', (event) => event.preventDefault())
    wc.setWindowOpenHandler(({ url }) => {
      openExternal(url)
      return { action: 'deny' }
    })
  })

  function openExternal(url: string): void {
    try {
      if (new URL(url).protocol === 'https:') void shell.openExternal(url)
    } catch {
      // not a URL
    }
  }

  // ---- Windows ----

  type WindowState = { bounds?: Electron.Rectangle; path?: string }
  let windowState: WindowState = {}
  try {
    windowState = JSON.parse(readFileSync(stateFile, 'utf8')) as WindowState
  } catch {
    // first launch
  }
  const saveWindowState = () => writeFileSync(stateFile, JSON.stringify(windowState))

  const webPreferences: Electron.WebPreferences = {
    partition: PARTITION,
    preload: join(app.getAppPath(), 'dist', 'preload.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webviewTag: false,
    // A hidden page keeps its timers, which notifications depend on (section 24.3).
    backgroundThrottling: false,
  }

  let quitting = false
  app.on('before-quit', () => (quitting = true))

  let mainWindow: BrowserWindow | null = null
  // The page has said hello on its channel: its listeners are in place, so
  // an `open` sent now is heard. Before that, the target waits.
  let listening = false
  const windows = () => [mainWindow].filter((w): w is BrowserWindow => !!w && !w.isDestroyed())

  function send(wc: WebContents | undefined, msg: MainToPage): void {
    if (wc && !wc.isDestroyed()) wc.send(IPC_TO_PAGE, msg)
  }
  const onApp = (wc: WebContents) => wc.getURL().startsWith(APP) && !wc.getURL().startsWith(`${APP}__shell/`)

  // The surface is one document: what is open is told to it, not put in the URL.
  const homeUrl = () => (auth.principal ? APP : SIGN_IN)

  /** A document that loads into a window starts with no subscriptions and is told the socket's state. */
  function attach(wc: WebContents): void {
    wc.on('did-navigate', () => forget(wc))
    wc.on('did-finish-load', () => {
      if (auth.principal && onApp(wc) && socket.state === 'open') send(wc, { t: 'chan.state', state: 'open' })
    })
  }

  function createMainWindow(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 720,
      minHeight: 480,
      ...windowState.bounds,
      show: false,
      title: 'OpenComputer',
      webPreferences,
    })
    mainWindow = win
    const wc = win.webContents
    attach(wc)
    win.once('ready-to-show', () => win.show())
    win.on('close', (event) => {
      windowState.bounds = win.getNormalBounds()
      saveWindowState()
      // Closing the window keeps the page alive, hidden, so it still
      // notifies; Quit ends the app.
      if (!quitting && process.platform === 'darwin') {
        event.preventDefault()
        win.hide()
      }
    })
    win.on('closed', () => {
      forget(wc)
      mainWindow = null
    })
    wc.on('did-navigate', () => (listening = false))
    void win.loadURL(homeUrl())
    return win
  }

  function showMain(): BrowserWindow {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createMainWindow()
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return win
  }

  deliverOpen = (target) => {
    const win = showMain()
    if (!auth.principal) return
    if (!listening) pendingOpen = target
    else send(win.webContents, { t: 'open', target })
  }

  // ---- The socket ----

  const router = new Router<WebContents>()
  const socket = new LiveSocket({
    url: edge.replace(/^http/, 'ws') + LIVE_PATH,
    token: () => auth.token(),
    invalidate: (t) => auth.invalidate(t),
    renewIn: () => auth.renewIn(),
    onFrame: (frame) => {
      for (const wc of router.incoming(frame)) send(wc, { t: 'chan.frame', frame })
    },
    onState: (state) => {
      if (state === 'closed') router.closed()
      for (const win of windows()) send(win.webContents, { t: 'chan.state', state })
    },
  })
  powerMonitor.on('resume', () => socket.kick())

  function forget(wc: WebContents): void {
    for (const stream of router.remove(wc)) socket.send({ t: 'unsub', stream })
  }

  // ---- Notifications (R27) ----

  const shown = new Set<Notification>()
  function notify(from: WebContents, n: Notice): void {
    if (!Notification.isSupported()) return
    const choices = n.askId ? (n.choices ?? []) : []
    const notification = new Notification({
      title: n.title,
      body: n.body,
      actions: choices.map((c) => ({ type: 'button' as const, text: c.label })),
    })
    shown.add(notification)
    const page = () => (!from.isDestroyed() && onApp(from) ? from : mainWindow?.webContents)
    notification.on('click', () => {
      shown.delete(notification)
      deliverOpen({ threadId: n.threadId, ...(n.askId ? { askId: n.askId } : {}) })
    })
    notification.on('action', (_event, index) => {
      shown.delete(notification)
      const choice = choices[index]
      // The page sends it as the thread's own `answer` entry (section 19.1).
      if (choice && n.askId) send(page(), { t: 'answer', threadId: n.threadId, askId: n.askId, choice: choice.id })
    })
    notification.on('close', () => shown.delete(notification))
    notification.show()
  }

  // ---- Backups of the write queue and drafts (section 26.3) ----

  const backupDir = () => {
    const p = auth.principal
    return p ? join(backupRoot, createHash('sha256').update(`${p.org}/${p.subject}`).digest('hex').slice(0, 32)) : null
  }
  const writes = new Map<string, Promise<void>>()
  function backupWrite(what: string, data: Uint8Array): void {
    const dir = backupDir()
    if (!dir) return
    const file = join(dir, `${what}.bin`)
    const next = (writes.get(file) ?? Promise.resolve())
      .then(async () => {
        await mkdir(dir, { recursive: true })
        await writeFile(`${file}.tmp`, data, { mode: 0o600 })
        await rename(`${file}.tmp`, file)
      })
      .catch(() => {})
    writes.set(file, next)
  }
  async function backupRead(what: string): Promise<Uint8Array | null> {
    const dir = backupDir()
    if (!dir) return null
    const file = join(dir, `${what}.bin`)
    await writes.get(file)
    try {
      return new Uint8Array(await readFile(file))
    } catch {
      return null
    }
  }

  // ---- The bridge ----

  /** Every message's sender is the main frame of one of this app's windows, on oc://app/. */
  function trusted(event: IpcMainEvent): boolean {
    const frame = event.senderFrame
    return !!frame && frame === event.sender.mainFrame && frame.url.startsWith(APP) && windows().some((w) => w.webContents === event.sender)
  }

  ipcMain.on(IPC_PRINCIPAL, (event) => {
    event.returnValue = trusted(event) && onApp(event.sender) ? auth.principal : null
  })

  const isString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
  const isBackup = (v: unknown): v is 'queue' | 'drafts' => v === 'queue' || v === 'drafts'

  ipcMain.on(IPC_TO_MAIN, (event, msg: PageToMain) => {
    if (!trusted(event) || !msg || typeof msg !== 'object') return
    const wc = event.sender
    if (msg.t === 'signin') {
      auth.signIn().then(
        () => app.focus({ steal: true }),
        (e: Error) => send(wc, { t: 'signin.error', message: e.message }),
      )
      return
    }
    // Everything below is the surface's, and only while signed in.
    if (!auth.principal || !onApp(wc)) return
    switch (msg.t) {
      case 'chan.send': {
        const frame = msg.frame as Frame
        if (!frame || typeof frame !== 'object' || typeof frame.t !== 'string' || frame.t === 'auth') return
        if (frame.t === 'hello' && wc === mainWindow?.webContents && !listening) {
          listening = true
          // A waiting target, or else where the window was when it last closed.
          const target = pendingOpen ?? locationTarget(windowState.path ?? '/')
          pendingOpen = null
          if (target) send(wc, { t: 'open', target })
        }
        const { forward, reply } = router.outgoing(wc, frame)
        if (forward) socket.send(frame)
        if (reply) send(wc, { t: 'chan.frame', frame: reply })
        return
      }
      case 'subs':
        if (Array.isArray(msg.streams) && msg.streams.length <= 128 && msg.streams.every((s) => isString(s, 128))) router.setSubs(wc, msg.streams)
        return
      case 'backup.write':
        if (isBackup(msg.what) && msg.data instanceof Uint8Array && msg.data.byteLength <= 64 * 1024 * 1024) backupWrite(msg.what, msg.data)
        return
      case 'backup.read':
        if (isBackup(msg.what) && isString(msg.id, 64)) {
          const id = msg.id
          void backupRead(msg.what).then((data) => send(wc, { t: 'backup.data', id, data }))
        }
        return
      case 'open.external':
        if (isString(msg.url, 4096)) openExternal(msg.url)
        return
      case 'location':
        if (wc === mainWindow?.webContents && isString(msg.path, 2048) && msg.path.startsWith('/') && !msg.path.startsWith('//')) {
          windowState.path = msg.path
          saveWindowState()
        }
        return
      case 'badge':
        if (Number.isInteger(msg.count) && msg.count >= 0) app.setBadgeCount(Math.min(msg.count, 9999))
        return
      case 'notify': {
        const n = msg.n
        if (!n || !isString(n.threadId, 64) || !isString(n.title, 256) || !isString(n.body, 1024)) return
        if (n.askId !== undefined && !isString(n.askId, 64)) return
        if (n.choices !== undefined && !(Array.isArray(n.choices) && n.choices.length <= 4 && n.choices.every((c) => c && isString(c.id, 128) && isString(c.label, 64)))) return
        notify(wc, n)
        return
      }
      case 'signout':
        void auth.signOut()
        return
    }
  })

  // ---- Signed in, signed out ----

  function signedIn(): void {
    socket.start()
    // S11: the hotkey brings the window forward at the start box.
    if (!globalShortcut.isRegistered(START_HOTKEY)) globalShortcut.register(START_HOTKEY, () => deliverOpen({ new: true }))
  }

  auth.onChange((principal) => {
    if (principal) {
      signedIn()
      for (const win of windows()) send(win.webContents, { t: 'principal', principal })
      void showMain().loadURL(homeUrl())
      return
    }
    // Signed out, or the credential was refused (section 20): the page is
    // told, then everything kept for that principal goes.
    socket.stop()
    globalShortcut.unregister(START_HOTKEY)
    for (const win of windows()) send(win.webContents, { t: 'signed-out' })
    app.setBadgeCount(0)
    windowState = { bounds: windowState.bounds }
    saveWindowState()
    rmSync(backupRoot, { recursive: true, force: true })
    const win = showMain()
    void win.loadURL(SIGN_IN).then(() => ses.clearStorageData())
  })

  // ---- The menu ----

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin'
        ? [
            {
              label: app.name,
              submenu: [
                { role: 'about' as const },
                { type: 'separator' as const },
                { label: 'Sign Out', click: () => void auth.signOut() },
                { type: 'separator' as const },
                { role: 'hide' as const },
                { role: 'hideOthers' as const },
                { role: 'unhide' as const },
                { type: 'separator' as const },
                { role: 'quit' as const },
              ],
            },
          ]
        : []),
      { label: 'File', submenu: [{ label: 'New Thread', accelerator: 'CommandOrControl+N', click: () => deliverOpen({ new: true }) }, { role: 'close' as const }] },
      { role: 'editMenu' as const },
      { label: 'View', submenu: [{ role: 'resetZoom' as const }, { role: 'zoomIn' as const }, { role: 'zoomOut' as const }, { type: 'separator' as const }, { role: 'togglefullscreen' as const }, ...(app.isPackaged ? [] : [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }])] },
      { role: 'windowMenu' as const },
    ]),
  )

  // ---- Start ----

  app.on('activate', () => showMain())
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('will-quit', () => globalShortcut.unregisterAll())

  createMainWindow()
  if (auth.principal) signedIn()
  startUpdates()
}
