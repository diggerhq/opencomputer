import type { Ask } from '../computer-sessions-api'

// An approval in words, read from its payload: `approval.input` is the tool's
// own input (Claude Code's or Codex's), `approval.title` Claude Code's
// permission title or "Claude wants to use X".

export type Input = Record<string, unknown>

export const str = (v: unknown) => (typeof v === 'string' ? v : null)

/** `mcp__server__tool` as its server and tool. */
export function mcpName(name: string) {
  const m = name.match(/^mcp__(.+?)__(.+)$/)
  return m ? { server: m[1], tool: m[2] } : null
}

export const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p

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

export const isPlan = (ask: Ask) => ask.approval?.toolName === 'ExitPlanMode'

/**
 * The approval in one line, a headline: the agent's own description of a
 * command when it gave one, else what the call does ("Run git push", "Edit
 * Billing.tsx"), else its title without the "Claude wants to" preamble.
 */
export function approvalLine(ask: Ask): string {
  const a = ask.approval
  if (!a) return 'Approve a tool call'
  const input = (a.input ?? {}) as Input
  const title = a.title?.trim() ?? ''
  const plain = title.replace(/^Claude wants to\s+/i, '')
  const own = title && plain === title ? title : null
  switch (a.toolName) {
    case 'Bash': {
      const desc = str(input.description)
      if (desc) return desc
      const prog = program(str(input.command) ?? '')
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
  const mcp = mcpName(a.toolName)
  if (mcp) {
    const words = mcp.tool.replace(/_/g, ' ')
    return `${words[0].toUpperCase()}${words.slice(1)} · ${mcp.server}`
  }
  return `Use ${a.toolName}`
}
