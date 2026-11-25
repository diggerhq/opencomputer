// The page the shell serves until the surface's desktop bundle exists. It is
// built on the same `Host` the surface will be given, and has one button per
// thing the bridge does, so the shell can be checked by hand and by the
// end-to-end test.
import { createDesktopHost } from '../host'

const host = createDesktopHost()
const root = document.getElementById('root')!

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.textContent = text
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  return e
}

if (location.pathname === '/start') startPanel()
else page()

function startPanel(): void {
  document.body.classList.add('panel')
  const input = el('input', '', { id: 'start', placeholder: 'Start a thread (placeholder: Enter opens the main window)' })
  root.append(input)
  host.onPanelShown(() => {
    input.value = ''
    input.focus()
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') host.openInMain({})
  })
}

function page(): void {
  const log = el('pre', '', { id: 'log' })
  const say = (what: string, v?: unknown) => {
    log.textContent += `${new Date().toISOString().slice(11, 23)}  ${what}${v === undefined ? '' : ` ${JSON.stringify(v)}`}\n`
    log.scrollTop = log.scrollHeight
  }
  const state = el('dd', 'closed', { id: 'state' })
  const facts = el('dl')
  facts.append(el('dt', 'Organization'), el('dd', host.principal.org, { id: 'org' }), el('dt', 'Subject'), el('dd', host.principal.subject, { id: 'subject' }), el('dt', 'Socket'), state, el('dt', 'Location'), el('dd', location.pathname + location.search))

  const chan = host.connect()
  chan.onState((s) => {
    state.textContent = s
    say('chan.state', s)
    if (s === 'open') {
      // Section 38.3, step 1: hello, and the feed's sub without waiting.
      chan.subs(['feed'])
      chan.send({ t: 'hello', protocol: 1, clientId: 'cl_PLACEH0LDER000000' })
      chan.send({ t: 'sub', stream: 'feed' })
    }
  })
  chan.onFrame((f) => say('chan.frame', f))
  host.onOpen((t) => say('open', t))
  host.onAnswer((a) => say('answer', a))
  host.onSignedOut(() => say('signed-out'))

  const actions: [string, string, () => void | Promise<void>][] = [
    [
      'feed',
      'GET /feed',
      async () => {
        const res = await host.api.fetch('/api/feed')
        say(`feed ${res.status}`, (await res.text()).slice(0, 600))
      },
    ],
    ['ping', 'Ping socket', () => chan.send({ t: 'ping' })],
    [
      'notify',
      'Notify (permission)',
      () => host.notify({ threadId: 'cs_0000000000000000', askId: 'ak_000000000000', title: 'Placeholder thread', body: 'Wants to run a command', choices: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }] }),
    ],
    ['badge', 'Badge 3', () => host.badge(3)],
    ['badge0', 'Badge 0', () => host.badge(0)],
    [
      'backup',
      'Backup write, read',
      async () => {
        await host.backup.write('drafts', new TextEncoder().encode(`draft at ${Date.now()}`))
        const back = await host.backup.read('drafts')
        say('backup.data', back ? new TextDecoder().decode(back) : null)
      },
    ],
    ['external', 'Open opencomputer.dev', () => host.openExternal('https://opencomputer.dev')],
    ['location', 'Mirror location', () => host.location('/thread/cs_0000000000000000')],
    ['signout', 'Sign out', () => host.signOut()],
  ]
  const row = el('div', '', { class: 'row' })
  for (const [id, label, run] of actions) {
    const b = el('button', label, { id })
    b.addEventListener('click', () => void Promise.resolve(run()).catch((e) => say(`${id} failed`, String(e))))
    row.append(b)
  }

  root.append(el('h1', 'OpenComputer'), el('p', 'The shell is running. The surface is not in this build yet; this page exercises the bridge.', { class: 'sub' }), facts, row, log)
}
