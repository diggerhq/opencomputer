// The parts of remark's syntax tree this plugin reads; typed here rather than
// importing mdast's types, which this app only has through react-markdown.
type MdNode = {
  type: string
  children?: MdNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
  data?: { hProperties?: Record<string, unknown> }
}

// A remark plugin that marks each fenced code block with whether its closing
// fence has arrived. While an agent's reply streams in, a block runs to the
// end of the text until the closing fence comes, and a diagram drawn from half
// its source would only flicker through errors; the renderer waits for this.
export function remarkFenceClosed() {
  return (tree: MdNode, file: { value: unknown }) => {
    const source = String(file.value)
    const visit = (node: MdNode) => {
      if (node.type === 'code') {
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        if (start === undefined || end === undefined) return
        const closed = isFenceClosed(source.slice(start, end))
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            'data-fence-closed': closed ? 'true' : 'false',
          },
        }
        return
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}

// Whether a fenced block's raw text ends in a fence that closes its opening
// one: the same character, at least as long. Blockquote markers and list
// indentation before either fence are allowed.
export function isFenceClosed(raw: string): boolean {
  const lines = raw.split('\n')
  if (lines.length < 2) return false
  const open = /^[ \t>]*(`{3,}|~{3,})/.exec(lines[0])
  const close = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/.exec(lines[lines.length - 1])
  if (!open || !close) return false
  return close[1][0] === open[1][0] && close[1].length >= open[1].length
}

type Mermaid = typeof import('mermaid').default

let loading: Promise<Mermaid> | undefined
// Loaded on the first diagram, as its own chunk: most pages never draw one.
function loadMermaid(): Promise<Mermaid> {
  loading ??= import('mermaid').then((m) => m.default)
  // A failed load (a deploy replaced the chunk, the network dropped) may
  // succeed next time.
  loading.catch(() => (loading = undefined))
  return loading
}

// mermaid's configuration is global, so renders take turns: each sets its
// theme and draws before the next begins.
let queue: Promise<unknown> = Promise.resolve()
let nextId = 0

export type Rendered = { svg: string } | { error: string }

// Drawn diagrams by theme and source, so a block mounted again (a list
// re-rendered, a thread reopened) shows its diagram at once.
const cache = new Map<string, Rendered>()
const CACHE_LIMIT = 50

export function cachedDiagram(source: string, dark: boolean) {
  return cache.get(cacheKey(source, dark))
}

export function renderDiagram(
  source: string,
  dark: boolean,
): Promise<Rendered> {
  const key = cacheKey(source, dark)
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)
  const run = queue.then(async (): Promise<Rendered> => {
    let mermaid: Mermaid
    try {
      mermaid = await loadMermaid()
    } catch {
      // Not cached: the library may load on a later try.
      return { error: "Couldn't load the diagram renderer." }
    }
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      // Throw on a bad diagram instead of drawing mermaid's error picture.
      suppressErrorRendering: true,
    })
    let result: Rendered
    try {
      const { svg } = await mermaid.render(`mermaid-${++nextId}`, source)
      result = { svg }
    } catch (e) {
      result = { error: errorLine(e) }
    }
    if (cache.size >= CACHE_LIMIT) {
      cache.delete(cache.keys().next().value as string)
    }
    cache.set(key, result)
    return result
  })
  queue = run.catch(() => undefined)
  return run
}

function cacheKey(source: string, dark: boolean) {
  return `${dark ? 'dark' : 'light'}\n${source}`
}

// The first line of mermaid's message: the rest is a caret drawing of the
// source, which the code block beside it already shows.
function errorLine(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message.split('\n')[0].trim().replace(/:$/, '') || 'Invalid diagram.'
}
