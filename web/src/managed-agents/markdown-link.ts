import { createContext, type ReactElement } from 'react'

// How a link is drawn, when whoever shows the markdown knows more about where
// it leads than its address. `plain` is the usual link, to be returned for any
// link there is nothing to add to. Read from context, not passed as a prop, so
// the renderer's components stay the same from one render to the next.
export type MarkdownLink = (href: string | undefined, plain: ReactElement) => ReactElement
export const MarkdownLinkContext = createContext<MarkdownLink | null>(null)
