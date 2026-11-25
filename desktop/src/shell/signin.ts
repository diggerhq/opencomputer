// The shell's own sign-in page, shown while there is no principal.
import type { OcBridge } from '../shared/bridge'

const oc = (window as unknown as { oc: OcBridge }).oc
const go = document.getElementById('go') as HTMLButtonElement
const line = document.getElementById('line')!
const error = document.getElementById('error')!

go.addEventListener('click', () => {
  go.disabled = true
  error.textContent = ''
  line.textContent = 'Finish signing in in your browser.'
  oc.send({ t: 'signin' })
  // The browser tab may be closed without an answer: let the person start again.
  setTimeout(() => (go.disabled = false), 5000)
})

oc.on((msg) => {
  if (msg.t !== 'signin.error') return
  go.disabled = false
  line.textContent = 'Sign in with your browser to continue.'
  error.textContent = msg.message
})
