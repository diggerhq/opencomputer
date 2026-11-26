import { memo } from 'react'
import { AgentMarkdown } from '@/managed-agents/AgentMarkdown'

// Markdown as the agents write it, through the dashboard's renderer. One line
// stays inline so it can sit inside other text.
export const Rich = memo(function Rich({ text }: { text: string }) {
  return <AgentMarkdown inline={!text.includes('\n')}>{text}</AgentMarkdown>
})
