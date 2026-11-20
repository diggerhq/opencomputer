import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { AgentMarkdown } from '../AgentMarkdown'
import type { Ask } from '../computer-sessions-api'
import { mcpName, str, type Input } from './ask-line'

// What an approval asks to run, read from its payload: `approval.input` is
// the tool's own input (Claude Code's or Codex's), so each known tool is
// shown the way a person checks it before allowing it, and anything else as
// its arguments.

/** The label over the detail: the tool, then where it acts. */
function head(ask: Ask): { tool: string; target: string | null } {
  const a = ask.approval!
  const input = (a.input ?? {}) as Input
  const mcp = mcpName(a.toolName)
  switch (a.toolName) {
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
  if (mcp) return { tool: mcp.tool, target: mcp.server }
  return { tool: a.toolName, target: null }
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
        'bg-muted max-h-60 overflow-auto rounded-lg px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap [font-variant-ligatures:none]',
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
  const a = ask.approval!
  const input = (a.input ?? {}) as Input
  switch (a.toolName) {
    case 'Bash':
      return <Block>{str(input.command) ?? ''}</Block>
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
        <div className="bg-muted max-h-72 overflow-auto rounded-lg px-4 py-3">
          <AgentMarkdown>{str(input.plan) ?? ''}</AgentMarkdown>
        </div>
      )
  }
  const entries = Object.entries(input)
  if (!entries.length) return null
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
  if (!ask.approval) return null
  const { tool, target } = head(ask)
  return (
    <div className="space-y-2">
      <p className="flex min-w-0 items-baseline gap-2 text-xs">
        <span className="text-muted-foreground shrink-0 font-medium">
          {tool}
        </span>
        {target ? (
          <span className="truncate font-mono" title={target}>
            {target}
          </span>
        ) : null}
      </p>
      {body(ask)}
    </div>
  )
}
