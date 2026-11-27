import { cn } from '@/lib/utils'

// The class strings the panes share: top bars, columns, composers, blocks.

// The Mac app has no title bar: the top bars drag the window (spec 24), and
// what can be clicked in them does not.
export const DRAG =
  'in-data-[platform=desktop]:[-webkit-app-region:drag] in-data-[platform=desktop]:[&_:is(button,a,input,[role=group])]:[-webkit-app-region:no-drag]'

// A pane's top bar.
export const HD = cn(
  'flex h-12 flex-none items-center gap-2 border-b pr-2 pl-4 whitespace-nowrap select-none',
  DRAG,
)
// The bar at the window's left edge leaves room for the list's button while the list is hidden.
export const LEFT = 'in-data-[list=hidden]:pl-12'

// A pane's column, which keeps its width while the pane animates.
export const IN = 'flex h-full min-w-[340px] flex-col'
// The conversation's measure, 45rem (max-w-180), centered in the pane with at
// least 1rem either side. As padding on a scroll area it holds the content;
// as margin it places a composer under it.
export const MEASURE = 'px-[max(1rem,calc(50%-22.5rem))]'
// A pane's composer, on the conversation's measure.
export const COMPOSER = 'mx-[max(1rem,calc(50%-22.5rem))] mt-2 mb-4'
// A block in a conversation: a proposal or an ask, with its buttons.
export const BLOCK = 'bg-card max-w-140 rounded-lg border px-4 py-3'
export const ACTS = 'mt-3 flex flex-wrap items-center gap-2'
