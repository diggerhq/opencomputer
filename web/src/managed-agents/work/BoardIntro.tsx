import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Check, ExternalLink, Loader2 } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Repository } from './api'
import { newItemUrl, repositoryName } from './board'
import { ConnectGitHubButton, RepositoryCombobox } from './RepositorySetting'

// What the board says before it has cards (WORK_WEB_NOTES "First visit"):
// the lanes drawn as placeholders behind one message, which says what the
// board is, what the knowledge repository is for, and offers the one next
// step. The example tree follows the item conventions agents are given
// (computer/src/workspaces/knowledge.ts): `work/NN-slug.md`, `done/`.

export type IntroStep = 'connect' | 'choose' | 'track'

/** Connect GitHub (1), choose the repository (2), or no items in it (3). */
export function BoardIntro({
  step,
  repository,
  email,
  checking = false,
}: {
  step: IntroStep
  /** The chosen repository, for `track`. */
  repository?: Repository | null
  /** The viewer's email, for the example file's `owner:`. */
  email?: string | null
  /** Whether GitHub is connected is still being read: hold the action. */
  checking?: boolean
}) {
  return (
    <GhostBoard>
      <Steps current={step} />
      {step === 'track' && repository ? (
        <Track repository={repository} email={email ?? null} />
      ) : (
        <>
          <h2 className="text-base leading-6 font-semibold tracking-tight text-balance">
            The work your team and its agents have in progress
          </h2>
          <p className="text-muted-foreground mt-1.5 text-sm text-pretty">
            Each card is a markdown file in a git repository. Agents read and
            update those files as they work, so there is nothing to keep in sync
            by hand.
          </p>
          <RepositoryFigure
            className="mt-5"
            root="knowledge"
            open={['12-usage-billing.md', '14-slack-formatting.md']}
            closed={['09-webhook-retries.md']}
            card={{
              number: 12,
              tag: 'billing',
              title: 'Usage billing',
              state: 'Metering is live; invoices next.',
            }}
          />
          <div className="mt-5 border-t pt-5">
            <h3 className="text-sm font-medium">Knowledge repository</h3>
            <p className="text-muted-foreground mt-0.5 text-sm text-pretty">
              The one repository where that work is written down:{' '}
              <Path>work/</Path> for open items, <Path>done/</Path> for closed
              ones.
            </p>
            <div className="mt-3">
              {checking ? (
                <Skeleton className="h-8 w-full" />
              ) : step === 'connect' ? (
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <p className="text-muted-foreground text-sm">
                    It is chosen from what GitHub lets the app read.
                  </p>
                  <ConnectGitHubButton variant="default" size="default" />
                </div>
              ) : (
                <>
                  <RepositoryCombobox current={null} prominent />
                  <p className="text-muted-foreground mt-2 text-xs">
                    Any repository works. Nothing is written to it until an
                    agent tracks something.
                  </p>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </GhostBoard>
  )
}

/** The first read of a repository: the lanes, and a line on what is going on. */
export function BoardReading({ repository }: { repository: Repository }) {
  return (
    <GhostBoard narrow>
      <div role="status" className="flex items-start gap-3">
        <Loader2
          className="text-muted-foreground mt-0.5 size-4 shrink-0 animate-spin"
          aria-hidden
        />
        <div>
          <h2 className="text-sm leading-5 font-medium">
            Reading {repositoryName(repository)} for the first time
          </h2>
          <p className="text-muted-foreground mt-1 text-sm text-pretty">
            Each file in <Path>work/</Path> and <Path>done/</Path> becomes a
            card. They show here once the first read is done.
          </p>
        </div>
      </div>
    </GhostBoard>
  )
}

// State 3: a repository with no items. One way in (ask an agent), and the
// file to add by hand as the quiet alternative.
function Track({
  repository,
  email,
}: {
  repository: Repository
  email: string | null
}) {
  return (
    <>
      <h2 className="text-base leading-6 font-semibold tracking-tight text-balance">
        Nothing is tracked in {repositoryName(repository)} yet
      </h2>
      <p className="text-muted-foreground mt-1.5 text-sm text-pretty">
        A card appears here for each file in its <Path>work/</Path> folder. Ask
        an agent to track something, in any session, and it writes the first
        one:
      </p>
      <blockquote className="bg-muted/60 mt-3 rounded-lg px-3.5 py-2.5 text-sm">
        Track the usage billing work: what is done and what is left.
      </blockquote>
      <RepositoryFigure
        className="mt-3"
        root={repository.name}
        open={['1-usage-billing.md']}
        closed={[]}
        card={{
          number: 1,
          title: 'Usage billing',
          state: 'Metering is live; invoices next.',
        }}
      />
      <div className="mt-5 flex flex-col-reverse items-start gap-3 border-t pt-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <a
          href={newItemUrl(repository, email)}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
        >
          Or add a file to <Path>work/</Path> on GitHub
          <ExternalLink className="size-3" aria-hidden />
        </a>
        <Button asChild>
          <Link to="/computer/sessions/new">Start a session</Link>
        </Button>
      </div>
    </>
  )
}

const STEPS: { id: IntroStep; label: string }[] = [
  { id: 'connect', label: 'Connect GitHub' },
  { id: 'choose', label: 'Choose a repository' },
  { id: 'track', label: 'Track a first item' },
]

/** Where this organization is in getting started, quietly. */
function Steps({ current }: { current: IntroStep }) {
  const at = STEPS.findIndex((s) => s.id === current)
  return (
    <ol
      aria-label="Getting started"
      className="text-muted-foreground mb-5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs sm:gap-x-2"
    >
      {STEPS.map((s, i) => (
        <li
          key={s.id}
          aria-current={i === at ? 'step' : undefined}
          className="flex items-center gap-2"
        >
          {i > 0 ? (
            <span
              aria-hidden
              className="bg-border hidden h-px w-4 shrink-0 sm:block"
            />
          ) : null}
          <span
            aria-hidden
            className={cn(
              'flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px] leading-none font-medium tabular-nums',
              i < at && 'bg-foreground/10 border-transparent',
              i === at && 'border-foreground text-foreground',
            )}
          >
            {i < at ? <Check className="size-2.5" /> : i + 1}
          </span>
          <span className={cn(i === at && 'text-foreground font-medium')}>
            {s.label}
            {i < at ? <span className="sr-only"> (done)</span> : null}
          </span>
        </li>
      ))}
    </ol>
  )
}

const Path = ({ children }: { children: ReactNode }) => (
  <code className="text-foreground/80 font-mono text-[0.92em]">{children}</code>
)

// The tree's rows are 20px, so the connector meets the first open file's
// row at its middle: 2 rows above it (root, work/) and half of its own. The
// card (76px: 10 + 16 + 4 + 16 + 2 + 16 + 10, and its border) is centred on
// that line, so the line meets its title.
const ROW = 20
const LINK_Y = 2 * ROW + ROW / 2
const CARD_H = 76

/**
 * A quiet monospace tree of an example knowledge repository, with a thin
 * line from its first open file to the card it becomes.
 */
function RepositoryFigure({
  root,
  open,
  closed,
  card,
  className,
}: {
  root: string
  open: string[]
  closed: string[]
  card: { number: number; tag?: string; title: string; state: string }
  className?: string
}) {
  const rows: { text: string; file?: boolean; first?: boolean }[] = [
    { text: `${root}/` },
    { text: '├─ work/' },
    ...open.map((f, i) => ({
      text: `│  ${i === open.length - 1 ? '└─' : '├─'} ${f}`,
      file: true,
      first: i === 0,
    })),
    { text: '└─ done/' },
    ...closed.map((f, i) => ({
      text: `   ${i === closed.length - 1 ? '└─' : '├─'} ${f}`,
      file: true,
    })),
  ]
  return (
    <figure
      aria-label={`An example: ${open[0]} in work/ is the card "${card.title}"`}
      className={cn(
        'bg-muted/40 flex items-start rounded-lg border px-4 py-3',
        className,
      )}
    >
      <pre
        aria-hidden
        className="text-muted-foreground/80 shrink-0 font-mono text-xs leading-5"
      >
        {rows.map((r) => (
          <div
            key={r.text}
            className={cn(
              r.first && 'text-foreground',
              !r.file && 'font-medium',
            )}
          >
            {r.text}
          </div>
        ))}
      </pre>
      <div
        aria-hidden
        className="hidden min-w-6 flex-1 items-center sm:flex"
        style={{ marginTop: LINK_Y - 2 }}
      >
        <span className="bg-muted-foreground/50 ml-3 size-1 shrink-0 rounded-full" />
        <span className="border-muted-foreground/40 h-0 flex-1 border-t border-dashed" />
        <span className="bg-muted-foreground/50 mr-0 size-1 shrink-0 rounded-full" />
      </div>
      <div
        aria-hidden
        className="bg-panel hidden w-48 shrink-0 rounded-md border p-2.5 shadow-[0_1px_1px_0_rgb(20_19_17/0.03)] sm:block"
        style={{ marginTop: LINK_Y - CARD_H / 2 }}
      >
        <div className="text-muted-foreground flex h-4 items-center gap-1.5 text-[11px]">
          <span className="font-medium tabular-nums">{card.number}</span>
          {card.tag ? (
            <span className="rounded-sm border px-1 leading-3.5">
              {card.tag}
            </span>
          ) : null}
        </div>
        <p className="mt-1 truncate text-xs leading-4 font-medium">
          {card.title}
        </p>
        <p className="text-muted-foreground mt-0.5 truncate text-[11px] leading-4">
          {card.state}
        </p>
      </div>
    </figure>
  )
}

/**
 * Three lanes of placeholder cards (dashed, still) behind the message, fading
 * out downwards. Below `lg` only the first lane is drawn, as the board stacks.
 */
function GhostBoard({
  narrow = false,
  children,
}: {
  narrow?: boolean
  children: ReactNode
}) {
  return (
    <div className="grid">
      <div
        aria-hidden
        className="col-start-1 row-start-1 grid gap-4 [mask-image:linear-gradient(to_bottom,black_45%,transparent)] lg:grid-cols-3"
      >
        <GhostLane title="In progress" cards={[3, 2, 3, 2]} />
        <GhostLane
          title="Ready to close"
          cards={[2, 3, 2]}
          className="hidden lg:flex"
        />
        <GhostLane
          title="Closed"
          cards={[2, 2, 3]}
          className="hidden lg:flex"
        />
      </div>
      <div
        className={cn(
          'bg-panel relative z-10 col-start-1 row-start-1 mx-3 mt-12 mb-16 self-start justify-self-center rounded-xl border p-6 shadow-sm sm:mx-6 sm:w-[34rem] sm:max-w-[calc(100%-3rem)]',
          narrow && 'sm:w-[28rem]',
        )}
      >
        {children}
      </div>
    </div>
  )
}

function GhostLane({
  title,
  cards,
  className,
}: {
  title: string
  // Each card's number of text bars.
  cards: number[]
  className?: string
}) {
  return (
    <div
      className={cn(
        'bg-muted/60 flex min-w-0 flex-col rounded-xl p-2 dark:bg-black/15',
        className,
      )}
    >
      <div className="text-muted-foreground flex h-9 items-center px-[13px] pb-1 text-sm">
        {title}
      </div>
      <div className="flex flex-col gap-2">
        {cards.map((bars, i) => (
          <GhostCard key={i} bars={bars} seed={i + title.length} />
        ))}
      </div>
    </div>
  )
}

// A card's outline: an identity bar, a title and state bars of a few widths.
const WIDTHS = ['w-3/4', 'w-2/3', 'w-5/6', 'w-1/2', 'w-3/5']

function GhostCard({ bars, seed }: { bars: number; seed: number }) {
  return (
    <div className="border-foreground/15 rounded-lg border border-dashed p-3">
      <div className="flex h-5 items-center gap-1.5">
        <span className="bg-foreground/[0.07] h-2 w-5 rounded-full" />
        <span className="bg-foreground/[0.05] h-2 w-10 rounded-full" />
      </div>
      <div className="mt-2 space-y-2 py-1">
        {Array.from({ length: bars }, (_, i) => (
          <span
            key={i}
            className={cn(
              'block h-2 rounded-full',
              i === 0 ? 'bg-foreground/[0.08]' : 'bg-foreground/[0.05]',
              WIDTHS[(seed + i) % WIDTHS.length],
            )}
          />
        ))}
      </div>
      <div className="mt-3 flex h-5 items-center justify-between">
        <span className="bg-foreground/[0.05] h-2 w-16 rounded-full" />
        <span className="bg-foreground/[0.05] h-2 w-6 rounded-full" />
      </div>
    </div>
  )
}
