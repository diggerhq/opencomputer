import { useEffect, useRef, useState } from 'react'
import {
  FolderDown,
  ListTree,
  Loader2,
  MessagesSquare,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  ChatMinimap,
  ChatMinimapItem,
} from '@/components/chat-minimap/components/chat-minimap'
import {
  IconTabs,
  IconTabsList,
  IconTabsTrigger,
} from '@/components/icon-tabs/components/icon-tabs'
import { Shimmer } from '@/components/shimmer/components/shimmer'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
        {title}
      </h2>
      {children}
    </section>
  )
}

const DEMO_TURNS = [
  {
    input: 'Summarize the last five deployments for the web agent.',
    reply:
      'All five deployments succeeded. The last three shipped the new retry policy; deploy 41 and 42 only changed environment variables. Median build time was 48s.',
    status: 'completed',
  },
  {
    input: 'Draft a changelog entry for the retry policy rollout.',
    reply:
      'Here is a draft under `changelog/2026-10-retry-policy.md`: transient tool-sandbox launches now retry with backoff instead of failing the session, and the worker long-polls sandbox status instead of ticking once a second.',
    status: 'completed',
  },
  {
    input: 'Post it to the docs site.',
    reply:
      'Opened a pull request against the docs repo with the new entry and a link from the changelog index. CI is green.',
    status: 'completed',
  },
  {
    input: 'While that merges, watch the error rate on deploys.',
    reply:
      'Watching the deploy error rate now. Baseline over the last hour is 0.4% — I will flag anything above 1%.',
    status: 'completed',
  },
  {
    input: 'One more: cancel the scheduled Sunday cleanup job.',
    reply:
      'Checking the schedule configuration and removing the Sunday cleanup cron.',
    status: 'running',
  },
]

// Mirrors the Session detail page wiring: a scroll-spy over the viewport marks
// the topmost visible turn, and clicking a rail line scrolls to it.
function ConversationDemo() {
  const turnEls = useRef<(HTMLElement | null)[]>([])
  const [activeTurn, setActiveTurn] = useState(0)

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const index = turnEls.current.indexOf(entry.target as HTMLElement)
          if (index >= 0) setActiveTurn(index)
        }
      },
      { rootMargin: '-15% 0px -65% 0px' },
    )
    for (const el of turnEls.current) {
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [])

  return (
    <div className="flex items-start gap-6 rounded-lg border p-6">
      <div className="min-w-0 flex-1 space-y-8">
        {DEMO_TURNS.map((turn, index) => (
          <div
            key={index}
            ref={(el) => {
              turnEls.current[index] = el
            }}
            className="scroll-mt-24 space-y-6"
          >
            <div>
              <p className="text-muted-foreground mb-1.5 text-[10px] font-semibold tracking-wider uppercase">
                You
              </p>
              <p className="bg-muted ml-auto max-w-2xl rounded-xl rounded-br-sm px-3.5 py-2.5 text-sm leading-6 whitespace-pre-wrap">
                {turn.input}
              </p>
            </div>
            <div className="max-w-3xl">
              <p className="text-muted-foreground mb-1.5 text-[10px] font-semibold tracking-wider uppercase">
                Agent
              </p>
              <p className="text-foreground/90 text-sm leading-6">
                {turn.reply}
              </p>
              {turn.status === 'running' ? (
                <p className="text-muted-foreground mt-3 flex items-center gap-1.5 text-xs">
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                  <Shimmer>Streaming response…</Shimmer>
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <ChatMinimap side="left" className="sticky top-6 hidden shrink-0 lg:flex">
        {DEMO_TURNS.map((turn, index) => (
          <ChatMinimapItem
            key={index}
            active={index === activeTurn}
            title={turn.input}
            description={`Turn ${index + 1} · ${turn.status}`}
            onClick={() => {
              setActiveTurn(index)
              turnEls.current[index]?.scrollIntoView({
                behavior: 'smooth',
                block: 'start',
              })
            }}
          />
        ))}
      </ChatMinimap>
    </div>
  )
}

export default function UiDemo() {
  const [tab, setTab] = useState('conversation')
  const [saving, setSaving] = useState(false)
  const [progress, setProgress] = useState<number | undefined>(undefined)

  return (
    <TooltipProvider>
      <div className="bg-background text-foreground mx-auto min-h-screen max-w-4xl space-y-10 px-6 py-10">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Notra UI components</h1>
            <p className="text-muted-foreground text-sm">
              Live swap-in on the OpenComputer dashboard.
            </p>
          </div>
          <ThemeToggle />
        </header>

        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-2">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="link">Link</Button>
            <Button
              loading={saving}
              onClick={() => {
                setSaving(true)
                setTimeout(() => setSaving(false), 2000)
              }}
            >
              {saving ? 'Saving' : 'Save changes'}
            </Button>
            <Button
              variant="secondary"
              progress={progress}
              onClick={() => {
                setProgress(0)
                const timer = setInterval(() => {
                  setProgress((value) => {
                    if ((value ?? 0) >= 100) {
                      clearInterval(timer)
                      return undefined
                    }
                    return (value ?? 0) + 10
                  })
                }, 150)
              }}
            >
              Upload file
            </Button>
          </div>
        </Section>

        <Section title="Icon tabs">
          <IconTabs value={tab} onValueChange={setTab} className="w-fit">
            <IconTabsList aria-label="Session detail" value={tab}>
              <IconTabsTrigger
                icon={<MessagesSquare size={14} />}
                value="conversation"
              >
                Conversation
              </IconTabsTrigger>
              <IconTabsTrigger icon={<ListTree size={14} />} value="events">
                Events<span className="text-[10px] opacity-70">12</span>
              </IconTabsTrigger>
              <IconTabsTrigger icon={<FolderDown size={14} />} value="files">
                Files
              </IconTabsTrigger>
            </IconTabsList>
          </IconTabs>
          <p className="text-muted-foreground text-sm">Active tab: {tab}</p>
        </Section>

        <Section title="Tooltip">
          <div className="flex gap-2">
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="outline">Hover me</Button>}
              />
              <TooltipContent>Depth surface tooltip</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="outline">And me</Button>}
              />
              <TooltipContent>
                The popup glides between triggers
              </TooltipContent>
            </Tooltip>
          </div>
        </Section>

        <Section title="Shimmer">
          <p className="text-sm">
            <Shimmer>Working</Shimmer>
          </p>
        </Section>

        <Section title="Toasts">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => toast.success('Deployment complete')}
            >
              Success
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                toast.warning('Seat limit almost reached', {
                  description: '9 of 10 seats are in use.',
                })
              }
            >
              Warning
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => toast.error('Sandbox failed to start')}
            >
              Error
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                toast('Session paused', {
                  description: 'The agent will resume on the next message.',
                })
              }
            >
              Info
            </Button>
          </div>
        </Section>

        <Section title="Chat minimap + conversation">
          <ConversationDemo />
        </Section>
      </div>
    </TooltipProvider>
  )
}
