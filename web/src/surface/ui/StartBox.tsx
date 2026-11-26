import { useSurface } from '../hooks'
import { Composer } from './bits'

// S5: one composer, no choice of kind. Nothing exists until the first message is sent.
export function StartBox() {
  const surface = useSurface()
  return (
    <div id="start" style={{ display: 'flex' }}>
      <h2>What do you want done?</h2>
      <Composer
        draftKey="new"
        placeholder="A question, a fix, or something bigger"
        rows={2}
        // The start box is its composer: New lands in it.
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        onSend={(text) => surface.start(text, { open: true })}
      />
      <p>
        No need to say what kind of thing it is.
        {surface.host.platform === 'desktop' && ' From any other app: ⌥Space.'}
      </p>
    </div>
  )
}
