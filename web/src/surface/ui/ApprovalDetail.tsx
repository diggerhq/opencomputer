import type { ReactNode } from 'react'
import type { Ask } from '@opencomputer/sdk/computer'
import { cn } from '@/lib/utils'
import { Rich } from './bits'

// What an approval asks to run, read from its payload: `approval.input` is the
// tool's own input (Claude Code's or Codex's), so each known tool is shown the
// way a person checks it before allowing it, and anything else as its
// arguments. Ported from the old sessions view's ask-detail and ask-line.

type Input = Record<string, unknown>

const str = (v: unknown) => (typeof v === 'string' ? v : null)

/** `mcp__server__tool` as its server and tool. */
function mcpName(name: string) {
  const m = name.match(/^mcp__(.+?)__(.+)$/)
  return m ? { server: m[1], tool: m[2] } : null
}

const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p

// Lines that set up a script rather than say what it runs.
const SETUP =
  /^(#|set\s|export\s|for\s|while\s|if\s|do$|then$|done|fi$|else$|\}|\{$|[A-Z_][A-Z0-9_]*=\S*$)/

/** The command's program, and its subcommand when it reads as one: "git push", "psql". */
function program(command: string) {
  const line = command
    .split('\n')
    .map((l) =>
      l
        .trim()
        .replace(/^(cd\s+\S+\s*(&&|;)\s*)+/, '')
        .replace(/^((sudo|env|time|nohup|exec)\s+)+/, '')
        .replace(/^([A-Z_][A-Z0-9_]*=\S+\s+)+/, ''),
    )
    .find((l) => l && !SETUP.test(l))
  if (!line) return null
  const [cmd, sub] = line.split(/\s+/)
  const name = basename(cmd)
  return sub && /^[a-z][a-z0-9:-]*$/.test(sub) ? `${name} ${sub}` : name
}

const toolOf = (ask: Ask) => str(ask.approval?.toolName) ?? ''
const inputOf = (ask: Ask) => (ask.approval?.input ?? {}) as Input

/**
 * The approval in one line: the agent's own description of a command when it
 * gave one, else what the call does ("Run git push", "Edit Billing.tsx"), else
 * its title without the "Claude wants to" preamble.
 */
function headline(ask: Ask): string {
  const a = ask.approval
  if (!a) return 'Needs your OK'
  const input = inputOf(ask)
  const title = str(a.title)?.trim() ?? ''
  const plain = title.replace(/^Claude wants to\s+/i, '')
  const own = title && plain === title ? title : null
  const tool = toolOf(ask)
  switch (tool) {
    case 'Bash': {
      const desc = str(input.description) ?? own
      if (desc) return desc
      const prog = program(str(input.command) ?? str(a.command) ?? '')
      return prog ? `Run ${prog}` : 'Run a command'
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const p = str(input.file_path) ?? str(input.notebook_path)
      return p ? `Edit ${basename(p)}` : 'Edit a file'
    }
    case 'Write': {
      const p = str(input.file_path)
      return p ? `Write ${basename(p)}` : 'Write a file'
    }
    case 'ExitPlanMode':
      return 'Review the plan'
  }
  if (own) return own
  if (plain && !/^use\s/i.test(plain))
    return plain[0].toUpperCase() + plain.slice(1)
  const mcp = mcpName(tool)
  if (mcp) {
    const words = mcp.tool.replace(/_/g, ' ')
    return `${words[0].toUpperCase()}${words.slice(1)} · ${mcp.server}`
  }
  return tool ? `Use ${tool}` : 'Needs your OK'
}

/** The label over the detail: the tool, then where it acts. */
function head(ask: Ask): { tool: string; target: string | null } {
  const input = inputOf(ask)
  const tool = toolOf(ask)
  switch (tool) {
    case 'Bash':
      return { tool: 'Command', target: str(input.cwd) }
    case 'Edit':
    case 'MultiEdit':
      return { tool: 'Edit', target: str(input.file_path) }
    case 'NotebookEdit':
      return { tool: 'Edit', target: str(input.notebook_path) }
    case 'Write':
      return { tool: 'Write', target: str(input.file_path) }
    case 'ExitPlanMode':
      return { tool: 'Plan', target: null }
  }
  const mcp = mcpName(tool)
  if (mcp) return { tool: mcp.tool, target: mcp.server }
  return { tool, target: null }
}

function Block({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <pre
      className={cn(
        'bg-card max-h-60 overflow-auto rounded-md border px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap [font-variant-ligatures:none]',
        className,
      )}
    >
      {children}
    </pre>
  )
}

function Diff({ lines }: { lines: string[] }) {
  return (
    <Block className="px-0">
      {lines.map((l, i) => (
        <span
          key={i}
          className={cn(
            'block px-3',
            l.startsWith('+') &&
              'bg-status-running-bg/70 text-status-running dark:bg-status-running-bg/40',
            l.startsWith('-') &&
              'bg-status-error-bg/70 text-status-error dark:bg-status-error-bg/40',
          )}
        >
          {l || ' '}
        </span>
      ))}
    </Block>
  )
}

const lines = (s: string, mark: string) =>
  s ? s.split('\n').map((l) => mark + l) : []

function body(ask: Ask): ReactNode {
  const input = inputOf(ask)
  switch (toolOf(ask)) {
    case 'Bash':
      return (
        <Block>{str(input.command) ?? str(ask.approval?.command) ?? ''}</Block>
      )
    case 'Edit':
      if (str(input.diff)) return <Diff lines={str(input.diff)!.split('\n')} />
      return (
        <Diff
          lines={[
            ...lines(str(input.old_string) ?? '', '- '),
            ...lines(str(input.new_string) ?? '', '+ '),
          ]}
        />
      )
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : []
      return (
        <Diff
          lines={edits.flatMap((e, i) => [
            ...(i ? ['  ⋯'] : []),
            ...lines(str(e.old_string) ?? '', '- '),
            ...lines(str(e.new_string) ?? '', '+ '),
          ])}
        />
      )
    }
    case 'NotebookEdit':
      return <Block>{str(input.new_source) ?? ''}</Block>
    case 'Write':
      return <Block>{str(input.content) ?? ''}</Block>
    case 'ExitPlanMode':
      return (
        <div className="bg-card max-h-72 overflow-auto rounded-md border px-4 py-3">
          <Rich text={str(input.plan) ?? ''} />
        </div>
      )
  }
  const entries = Object.entries(input)
  if (!entries.length) {
    const command = str(ask.approval?.command)
    return command ? <Block>{command}</Block> : null
  }
  // Arguments as name and value; a value that is not text is shown as JSON.
  return (
    <Block className="grid grid-cols-[max-content_1fr] gap-x-4">
      {entries.map(([k, v]) => (
        <span key={k} className="contents">
          <span className="text-muted-foreground">{k}</span>
          <span>{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</span>
        </span>
      ))}
    </Block>
  )
}

/** The call an approval would make: what runs and where, in full. */
export function ApprovalDetail({ ask }: { ask: Ask }) {
  if (!ask.approval) return <div className="font-medium">Needs your OK</div>
  const { tool, target } = head(ask)
  const detail = body(ask)
  return (
    <>
      <div className="font-medium">{headline(ask)}</div>
      {(detail || tool) && (
        <div className="mt-2 space-y-1.5">
          {tool && (
            <p className="flex min-w-0 items-baseline gap-2 text-xs">
              <span className="text-muted-foreground shrink-0 font-medium">
                {tool}
              </span>
              {target && (
                <span className="truncate font-mono" title={target}>
                  {target}
                </span>
              )}
            </p>
          )}
          {detail}
        </div>
      )}
    </>
  )
}
