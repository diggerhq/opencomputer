import { memo } from 'react'
import { AgentMarkdown } from '@/managed-agents/AgentMarkdown'

// Markdown as the agents write it, through the dashboard's renderer. One line
// stays inline so it can sit inside other text; a message read at the reading
// size is always its own block.
export const Rich = memo(function Rich({
  text,
  size = 'sm',
}: {
  text: string
  size?: 'sm' | 'reading'
}) {
  return (
    <AgentMarkdown size={size} inline={size === 'sm' && !text.includes('\n')}>
      {text}
    </AgentMarkdown>
  )
})
