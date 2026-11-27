import { useEffect, useLayoutEffect, useRef } from 'react'
import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands'
import { HighlightStyle, Language, defineLanguageFacet, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { Annotation, Compartment, EditorState, RangeSetBuilder, Transaction, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  placeholder as placeholderExt,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { GFM, parser } from '@lezer/markdown'
import { cn } from '@/lib/utils'

// ---- the composer's text: markdown that formats as it is typed ----
//
// CodeMirror 6, like the Doc's editor: the draft stays plain markdown, byte for
// byte, while code, emphasis and links show as they will be read. The marks
// (backticks, asterisks, fences) stay, faint, so what is typed is what is sent
// (Discord's way). The box grows with the text up to a share of the window,
// then scrolls inside a fixed padding, so no line slides under the border.

// Enter sends, except inside a code block, where it is a newline (Slack's way):
// code is typed line by line. Shift+Enter is a newline that continues a list.
function inCodeBlock(state: EditorState): boolean {
  const pos = state.selection.main.head
  for (let n: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name !== 'FencedCode') continue
    // At the end of the closing fence, the block is done: Enter sends.
    const marks = n.getChildren('CodeMark')
    return marks.length < 2 || pos < marks[marks.length - 1].to
  }
  return false
}

// Markdown straight from its parser, with GitHub's additions (autolinks,
// strikethrough, tables). @codemirror/lang-markdown would bring HTML, CSS and
// JavaScript support along, for HTML inside markdown: four times the code.
const md = new Language(defineLanguageFacet(), parser.configure(GFM), [], 'markdown')

// Shift+Enter on a list item starts the next one; on an empty item it ends
// the list (Slack's and Linear's way).
const listItem = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/
function continueList(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  const m = listItem.exec(line.text)
  if (!m || sel.head < line.from + m[0].length) return false
  if (line.text.length === m[0].length) {
    view.dispatch({ changes: { from: line.from, to: line.to }, scrollIntoView: true, userEvent: 'delete' })
    return true
  }
  const bullet = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2]
  const next = `\n${m[1]}${bullet}${m[5]}${m[6] ? '[ ] ' : ''}`
  view.dispatch(state.replaceSelection(next), { scrollIntoView: true, userEvent: 'input' })
  return true
}

const external = Annotation.define<boolean>()

// The placeholder changes as the agent works; it is swapped in place, so the
// editor (and its focus) stays.
const prompt = (text: string) => [
  placeholderExt(text),
  EditorView.contentAttributes.of({ 'aria-label': text }),
]

// Lines of a fenced block get a band; inline code gets a chip.
const band = Decoration.line({ class: 'cm-md-fence' })
const bandTop = Decoration.line({ class: 'cm-md-fence cm-md-fence-top' })
const bandBottom = Decoration.line({ class: 'cm-md-fence cm-md-fence-bottom' })
const bandOnly = Decoration.line({ class: 'cm-md-fence cm-md-fence-top cm-md-fence-bottom' })
const chip = Decoration.mark({ class: 'cm-md-code' })

function decorate(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>()
  const { doc } = view.state
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (n) => {
        if (n.name === 'FencedCode') {
          const first = doc.lineAt(n.from).number
          const last = doc.lineAt(n.to).number
          for (let l = first; l <= last; l++) {
            const line = doc.line(l)
            b.add(line.from, line.from, first === last ? bandOnly : l === first ? bandTop : l === last ? bandBottom : band)
          }
          return false
        }
        if (n.name === 'InlineCode') b.add(n.from, n.to, chip)
      },
    })
  }
  return b.finish()
}

const codeShapes = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = decorate(view)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = decorate(u.view)
    }
  },
  { decorations: (v) => v.decorations },
)

// When the text scrolls, the edge it runs past fades: a cut line reads as more
// above or below, not as a glitch.
const edges = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      view.scrollDOM.addEventListener('scroll', this.mark, { passive: true })
      this.mark()
    }
    mark = () => {
      const s = this.view.scrollDOM
      s.classList.toggle('cm-more-above', s.scrollTop > 1)
      s.classList.toggle('cm-more-below', s.scrollTop + s.clientHeight < s.scrollHeight - 1)
    }
    update(u: ViewUpdate) {
      if (u.geometryChanged) this.mark()
    }
    destroy() {
      this.view.scrollDOM.removeEventListener('scroll', this.mark)
    }
  },
)

const looks = HighlightStyle.define([
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.heading, fontWeight: '600' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.85em' },
  // Links read as in a message: the text's colour, underlined.
  { tag: [tags.link, tags.url], textDecoration: 'underline', textDecorationColor: 'color-mix(in oklab, currentColor 40%, transparent)', textUnderlineOffset: '3px' },
  { tag: tags.quote, color: 'var(--muted-foreground)' },
  // The marks themselves: backticks, asterisks, fences, list bullets, #.
  { tag: [tags.processingInstruction, tags.contentSeparator], color: 'color-mix(in oklab, var(--faint) 65%, transparent)' },
])

const theme = EditorView.theme({
  '&': { color: 'var(--foreground)', backgroundColor: 'transparent', fontSize: 'var(--text-reading)' },
  '&.cm-focused': { outline: 'none' },
  // The scroller is the box's text area: it grows, then scrolls. Its padding
  // sits outside the scrolling, so lines meet a clean edge, never the border.
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: 'var(--text-reading--line-height)',
    letterSpacing: 'var(--text-reading--letter-spacing)',
    maxHeight: 'var(--composer-max, 40dvh)',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
  },
  '.cm-scroller.cm-more-above': { maskImage: 'linear-gradient(to bottom, transparent, black 12px)' },
  '.cm-scroller.cm-more-below': { maskImage: 'linear-gradient(to top, transparent, black 12px)' },
  '.cm-scroller.cm-more-above.cm-more-below': {
    maskImage: 'linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)',
  },
  '.cm-content': { padding: '0 10px', caretColor: 'var(--foreground)', minHeight: 'var(--composer-min, 24px)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--foreground)', borderLeftWidth: '1.5px' },
  '.cm-placeholder': { color: 'var(--faint)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in oklab, var(--ring) 25%, transparent)',
  },
  '.cm-md-code': { backgroundColor: 'var(--muted)', borderRadius: '4px', padding: '1px 0' },
  '.cm-md-fence': {
    backgroundColor: 'var(--muted)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.85em',
    // The band runs past the text, as a code block does in a message.
    padding: '0 10px !important',
    margin: '0 -10px',
  },
  '.cm-md-fence-top': { borderTopLeftRadius: '6px', borderTopRightRadius: '6px' },
  '.cm-md-fence-bottom': { borderBottomLeftRadius: '6px', borderBottomRightRadius: '6px' },
})

export function MarkdownInput({
  value,
  onChange,
  onSend,
  onFiles,
  placeholder,
  draftKey,
  rows = 1,
  focus,
  className,
}: {
  value: string
  onChange: (text: string) => void
  // `meta`: whether ⌘ or Ctrl was held on the Enter that sent.
  onSend: (e: { meta: boolean }) => void
  // Files pasted or dropped on the text: the composer attaches them.
  onFiles?: (files: File[]) => void
  placeholder: string
  draftKey: string
  rows?: number
  // Take the focus when it opens, and on each new draft.
  focus?: boolean
  className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // The latest props, for handlers made once with the editor.
  const said = useRef(new Compartment())
  const live = useRef({ onChange, onSend, onFiles })
  useLayoutEffect(() => {
    live.current = { onChange, onSend, onFiles }
  })

  useEffect(() => {
    const send = (meta: boolean) => () => {
      live.current.onSend({ meta })
      return true
    }
    const extensions: Extension[] = [
      history(),
      // Enter is bound ahead of the defaults so it sends; CodeMirror never runs
      // keys mid-composition, so CJK and accents are not cut off.
      keymap.of([
        { key: 'Enter', run: (v) => (inCodeBlock(v.state) ? insertNewline(v) : send(false)()) },
        // Either ⌘ or Ctrl, on any platform, as the textarea took it.
        { key: 'Meta-Enter', run: send(true) },
        { key: 'Ctrl-Enter', run: send(true) },
        { key: 'Shift-Enter', run: (v) => continueList(v) || insertNewline(v) },
        { key: 'Escape', run: (v) => (v.contentDOM.blur(), true) },
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      md,
      syntaxHighlighting(looks),
      codeShapes,
      edges,
      theme,
      EditorView.lineWrapping,
      said.current.of(prompt(placeholder)),
      EditorView.contentAttributes.of({
        'data-draft': draftKey,
        spellcheck: 'true',
        autocorrect: 'on',
        autocapitalize: 'sentences',
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !u.transactions.some((t) => t.annotation(external))) live.current.onChange(u.state.doc.toString())
      }),
      EditorView.domEventHandlers({
        // Files become attachments; CodeMirror would read a dropped file in as text.
        paste: (e) => {
          const files = [...(e.clipboardData?.files ?? [])]
          if (!files.length || !live.current.onFiles) return false
          e.preventDefault()
          live.current.onFiles(files)
          return true
        },
        // The box around takes the drop (Composer); here only CodeMirror's own is skipped.
        drop: (e) => !!e.dataTransfer?.types.includes('Files'),
      }),
    ]
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: value, extensions, selection: { anchor: value.length } }),
    })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
    // The editor is made once per draft; the text and placeholder follow below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])

  useEffect(() => {
    view.current?.dispatch({ effects: said.current.reconfigure(prompt(placeholder)) })
  }, [placeholder])

  // The draft changed from outside (sent, or set by another view): follow it.
  useEffect(() => {
    const v = view.current
    if (!v) return
    const doc = v.state.doc.toString()
    if (doc === value) return
    v.dispatch({
      changes: { from: 0, to: doc.length, insert: value },
      selection: { anchor: Math.min(v.state.selection.main.head, value.length) },
      annotations: [external.of(true), Transaction.addToHistory.of(false)],
    })
  }, [value])

  useEffect(() => {
    if (focus) view.current?.focus()
  }, [focus, draftKey])

  return (
    <div
      ref={host}
      data-slot="composer-input"
      className={cn('min-w-0 py-2', className)}
      style={{ ['--composer-min' as string]: `${rows * 24}px` }}
    />
  )
}
