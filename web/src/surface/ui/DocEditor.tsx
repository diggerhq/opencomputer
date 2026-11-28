import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'

// The Doc's editor (S4, spec 26.1): CodeMirror 6, which keeps the markdown
// byte for byte. Colours and type are the dashboard's tokens.

const theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: 'var(--foreground)',
    fontSize: '12.5px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.65' },
  '.cm-content': { padding: '12px 14px', caretColor: 'var(--foreground)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection':
    { backgroundColor: 'var(--accent)' },
})

// Fixed for the editor's life, so CodeMirror never reconfigures as the parent renders.
const extensions = [
  markdown(),
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({
    'aria-label': 'Doc',
    spellcheck: 'false',
  }),
]

export function DocEditor(props: {
  value: string
  onChange: (text: string) => void
  onSave: () => void
}) {
  return (
    <CodeMirror
      className="bg-card focus-within:border-ring/60 min-h-0 w-full max-w-180 flex-1 overflow-hidden rounded-md border shadow-xs transition-[color,box-shadow]"
      height="100%"
      theme={theme}
      // The editor opens on the person's own Edit, so it takes the focus.
      onCreateEditor={(view) => view.focus()}
      // Mod-S saves; CodeMirror binds nothing to it, so it bubbles up here.
      onKeyDown={(e) => {
        if (
          (e.metaKey || e.ctrlKey) &&
          !e.altKey &&
          e.key.toLowerCase() === 's'
        ) {
          e.preventDefault()
          props.onSave()
        }
      }}
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        autocompletion: false,
        closeBrackets: false,
        bracketMatching: false,
      }}
      extensions={extensions}
      value={props.value}
      onChange={props.onChange}
    />
  )
}
