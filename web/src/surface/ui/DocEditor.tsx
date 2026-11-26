import { useMemo, useRef } from 'react'
import CodeMirror, { EditorView, keymap, Prec } from '@uiw/react-codemirror'
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

export function DocEditor(props: {
  value: string
  onChange(text: string): void
  onSave(): void
}) {
  const save = useRef(props.onSave)
  save.current = props.onSave
  const extensions = useMemo(
    () => [
      markdown(),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        'aria-label': 'Doc',
        spellcheck: 'false',
      }),
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              save.current()
              return true
            },
          },
        ]),
      ),
    ],
    [],
  )
  return (
    <CodeMirror
      className="bg-card focus-within:border-ring focus-within:ring-ring/50 min-h-0 w-full max-w-180 flex-1 overflow-hidden rounded-md border shadow-xs transition-[color,box-shadow] focus-within:ring-[3px]"
      height="100%"
      theme={theme}
      autoFocus
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
