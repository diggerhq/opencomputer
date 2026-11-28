import { useEffect, useLayoutEffect, useRef } from 'react'
import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands'
import { HighlightStyle, Language, defineLanguageFacet, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  StateField,
  Transaction,
  type Extension,
  type Range,
} from '@codemirror/state'
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
// (backticks, asterisks, fences) hide once the cursor leaves what they mark,
// and come back, faint, when it returns (Obsidian's way), so what is sent can
// always be seen and edited. The box grows with the text up to a share of the window,
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
const hide = Decoration.replace({})
// A fence line, out of the way: the whole line, not a blank one.
const hideLine = Decoration.replace({ block: true })

// The marks of each kind of span, hidden while the cursor is outside it.
const marksOf: Record<string, string[]> = {
  InlineCode: ['CodeMark'],
  Emphasis: ['EmphasisMark'],
  StrongEmphasis: ['EmphasisMark'],
  Strikethrough: ['StrikethroughMark'],
  // [text](url) reads as its text, underlined.
  Link: ['LinkMark', 'URL', 'LinkTitle'],
}

function decorate(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  const { doc, selection } = state
  // Touching counts: with the cursor just after `code`, the backticks show.
  const near = (from: number, to: number) => selection.ranges.some((r) => r.from <= to && r.to >= from)
  syntaxTree(state).iterate({
    enter: (n) => {
      if (n.name === 'FencedCode') {
        const top = doc.lineAt(n.from)
        const end = doc.lineAt(n.to)
        const marks = n.node.getChildren('CodeMark')
        // A finished block with code in it folds its fences away; an open one,
        // or one being edited, shows them.
        const fold = marks.length >= 2 && end.number - top.number >= 2 && !near(top.from, end.to)
        const first = fold ? top.number + 1 : top.number
        const last = fold ? end.number - 1 : end.number
        if (fold) out.push(hideLine.range(top.from, top.to), hideLine.range(end.from, end.to))
        for (let l = first; l <= last; l++) {
          const at = doc.line(l).from
          out.push((first === last ? bandOnly : l === first ? bandTop : l === last ? bandBottom : band).range(at))
        }
        return false
      }
      const kinds = marksOf[n.name]
      if (!kinds) return
      if (n.name === 'InlineCode') out.push(chip.range(n.from, n.to))
      if (near(n.from, n.to)) return
      for (const k of kinds) for (const m of n.node.getChildren(k)) if (m.to > m.from) out.push(hide.range(m.from, m.to))
    },
  })
  return Decoration.set(out, true)
}

// A field, not a plugin: hiding a fence takes its whole line, which only a
// field may do. The composer's text is short, so it is all decorated at once.
const shapes = StateField.define<DecorationSet>({
  create: decorate,
  update: (d, tr) =>
    tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? decorate(tr.state) : d,
  provide: (f) => EditorView.decorations.from(f),
})

// ⌘B, ⌘I, ⌘E wrap the selection in a mark, or take it off again (Slack's,
// GitHub's and Linear's keys). With nothing selected, the cursor lands between.
const wrap = (mark: string) => (view: EditorView) => {
  const { state } = view
  const n = mark.length
  view.dispatch(
    state.changeByRange((r) =>
      state.sliceDoc(r.from - n, r.from) === mark && state.sliceDoc(r.to, r.to + n) === mark
        ? {
            changes: [
              { from: r.from - n, to: r.from },
              { from: r.to, to: r.to + n },
            ],
            range: EditorSelection.range(r.from - n, r.to - n),
          }
        : {
            changes: [
              { from: r.from, insert: mark },
              { from: r.to, insert: mark },
            ],
            range: EditorSelection.range(r.from + n, r.to + n),
          },
    ),
    { scrollIntoView: true, userEvent: 'input' },
  )
  return true
}

// A link pasted over selected text links that text (Slack's and GitHub's way).
const url = /^https?:\/\/\S+$/
function pasteLink(view: EditorView, text: string): boolean {
  const { state } = view
  const r = state.selection.main
  if (state.selection.ranges.length > 1 || r.empty || !url.test(text)) return false
  const label = state.sliceDoc(r.from, r.to)
  if (label.includes('\n') || url.test(label)) return false
  const link = `[${label}](${text})`
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: link },
    selection: { anchor: r.from + link.length },
    userEvent: 'input.paste',
  })
  return true
}

// The third backtick at the start of a line opens a block and closes it below,
// with the cursor after the fence for a language, then Enter (Slack's way).
const closeFence = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '`' || from !== to || inCodeBlock(view.state)) return false
  const line = view.state.doc.lineAt(from)
  const lead = /^(\s*)``$/.exec(line.text.slice(0, from - line.from))
  if (!lead || line.to !== to) return false
  view.dispatch({
    changes: { from, insert: `\`\n${lead[1]}\`\`\`` },
    selection: { anchor: from + 1 },
    userEvent: 'input.type',
  })
  return true
})

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
        { key: 'Mod-b', run: wrap('**') },
        { key: 'Mod-i', run: wrap('_') },
        { key: 'Mod-e', run: wrap('`') },
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
      shapes,
      closeFence,
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
        paste: (e, view) => {
          const files = [...(e.clipboardData?.files ?? [])]
          if (!files.length) return pasteLink(view, e.clipboardData?.getData('text/plain').trim() ?? '')
          if (!live.current.onFiles) return false
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
