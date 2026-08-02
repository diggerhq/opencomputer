import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Bot,
  BriefcaseBusiness,
  Check,
  ChevronRight,
  Clipboard,
  ClipboardCheck,
  Lightbulb,
  Loader2,
  MessageSquareText,
  Plus,
  Sparkles,
  TrendingUp,
  Workflow,
} from 'lucide-react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import { notifyError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import {
  displayManagedAgentName,
  getManagedAgents,
  getManagedAgentTemplates,
  type ManagedAgentTemplate,
} from './api'

const categories = [
  'Comms',
  'Operations',
  'Admin',
  'Growth',
  'Insights',
] as const

type Category = (typeof categories)[number]

const starterCopy = [
  {
    title: 'Choose a job for your next agent.',
    description:
      'Pick a starting point, copy its build prompt, and turn it into an agent you can develop and deploy from source.',
    sectionTitle: 'Ideas to start with',
    sectionDescription:
      'Each prompt creates an editable agent repository you can make your own.',
  },
  {
    title: 'What should your agent take care of?',
    description:
      'Start with a useful workflow, shape the source locally, and deploy it when it is ready.',
    sectionTitle: 'Pick a starting point',
    sectionDescription:
      'Copy an agent prompt, then adapt the generated source to your workflow.',
  },
  {
    title: 'Start with a real task.',
    description:
      'Choose a workflow below and use the generated source as the beginning of your next agent.',
    sectionTitle: 'Agent ideas',
    sectionDescription:
      'Explore a use case, copy its prompt, and keep building from the generated repository.',
  },
] as const

const categoryIcons = {
  Comms: MessageSquareText,
  Operations: Workflow,
  Admin: BriefcaseBusiness,
  Growth: TrendingUp,
  Insights: Lightbulb,
} satisfies Record<Category, typeof Sparkles>

function shuffled<T>(values: readonly T[]) {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1))
    ;[result[index], result[other]] = [result[other], result[index]]
  }
  return result
}

function cliCommand(origin: string, command: string) {
  const apiOption =
    origin === 'https://app.opencomputer.dev' ? '' : ` --api-url ${origin}`
  return `opencomputer${apiOption} ${command}`
}

function buildSetupPrompt(template: ManagedAgentTemplate, origin: string) {
  const integrations = template.integrations.join(', ')
  const firstPrompt =
    template.suggestedPrompts[0] ?? `Help me configure ${template.name}.`
  return `Create a local "${template.name}" OpenComputer agent repository for me.

The agent's job:
${template.description}

Suggested integrations:
${integrations}

Use the OpenComputer CLI and keep the agent as editable source code in this workspace.

1. Check whether the \`opencomputer\` command is available. If it is missing, install the \`@opencomputer/cli\` package.
2. Authenticate interactively:
   ${cliCommand(origin, 'login')}
3. Initialize the source template in the current repository:
   ${cliCommand(origin, `init ${template.id} .`)}
4. Run \`npm install\` in the repository.
5. Inspect and tailor the checked-in source: \`opencomputer.toml\`, \`instructions.md\`, \`agent.ts\`, \`tools/\`, \`connections/\`, \`skills/\`, \`workspace/\`, and \`evals/\`.
6. Keep the stable \`id\` in \`opencomputer.toml\`; future deployments of this repository must create new versions of that same agent.
7. Add and authorize only supported connections. For Gmail, use \`opencomputer tools add gmail\` and \`${cliCommand(origin, 'connect google')}\`. Connect Slack from the deployed agent's Channels tab after deployment.
8. Test the editable agent locally with OpenCode:
   \`opencomputer session "${firstPrompt.replace(/"/g, '\\"')}"\`
9. Make any necessary source changes and test again.
10. Commit the agent source, including \`opencomputer.toml\`, to Git.
11. Deploy from inside the repository:
   ${cliCommand(origin, 'deploy')}

Connect only integrations that are actually available. Ask me for authorization when a connection requires it, never print credentials, and do not claim an integration or deployment succeeded unless the CLI confirms it.`
}

function TemplateCard({
  template,
  deployed,
  copied,
  onCopy,
}: {
  template: ManagedAgentTemplate
  deployed: boolean
  copied: boolean
  onCopy: () => void
}) {
  const Icon = categoryIcons[template.category as Category] ?? ClipboardCheck
  return (
    <Panel className="flex h-full flex-col overflow-hidden">
      <PanelHeader className="border-0 pb-2">
        <div className="flex min-w-0 items-start gap-3">
          <div className="bg-primary/8 text-primary flex size-9 shrink-0 items-center justify-center rounded-md">
            <Icon className="size-4" strokeWidth={1.6} aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <PanelTitle className="text-base">{template.name}</PanelTitle>
              {deployed ? (
                <span className="bg-status-running-bg text-status-running rounded-full px-2 py-0.5 text-[10px] font-medium">
                  Deployed
                </span>
              ) : null}
            </div>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {template.category}
            </p>
          </div>
        </div>
      </PanelHeader>
      <PanelContent className="flex flex-1 flex-col pt-1">
        <PanelDescription className="min-h-10">
          {template.description}
        </PanelDescription>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {template.integrations.map((integration) => (
            <span
              key={integration}
              className="bg-muted text-muted-foreground rounded-md border px-2 py-1 text-[10px] font-medium"
            >
              {integration}
            </span>
          ))}
        </div>
        <div className="mt-5 space-y-2">
          <p className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
            First task
          </p>
          <p className="text-foreground/80 text-sm">
            “{template.suggestedPrompts[0]}”
          </p>
        </div>
        <Button
          className="mt-6 w-full"
          variant={copied ? 'secondary' : 'default'}
          onClick={onCopy}
        >
          {copied ? <Check /> : <Clipboard />}
          {copied ? 'Agent prompt copied' : 'Copy agent prompt'}
        </Button>
      </PanelContent>
    </Panel>
  )
}

export default function ManagedAgentsHome({
  startersOnly = false,
}: {
  startersOnly?: boolean
}) {
  const [selectedCategory, setSelectedCategory] = useState<Category>('Comms')
  const [copiedTemplateId, setCopiedTemplateId] = useState<string>()
  const [categoryOrder] = useState(() => shuffled(categories))
  const [copy] = useState(
    () => starterCopy[Math.floor(Math.random() * starterCopy.length)],
  )
  const agents = useQuery({
    queryKey: ['managed-agents'],
    queryFn: getManagedAgents,
  })
  const deployedAgents = agents.data ?? []
  const firstRun =
    !agents.isLoading && !agents.isError && deployedAgents.length === 0
  const showStarters = startersOnly || firstRun
  const templates = useQuery({
    queryKey: ['managed-agent-templates'],
    queryFn: getManagedAgentTemplates,
    enabled: showStarters,
  })
  const randomizedTemplates = useMemo(
    () => shuffled(templates.data ?? []),
    [templates.data],
  )
  const visibleTemplates = useMemo(
    () =>
      randomizedTemplates.filter(
        (template) => template.category === selectedCategory,
      ),
    [randomizedTemplates, selectedCategory],
  )

  async function copySetupPrompt(template: ManagedAgentTemplate) {
    try {
      await navigator.clipboard.writeText(
        buildSetupPrompt(template, window.location.origin),
      )
      setCopiedTemplateId(template.id)
      toast.success(`${template.name} agent prompt copied`)
    } catch (error) {
      notifyError("Couldn't copy the agent prompt.", error)
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={startersOnly ? 'Deploy another agent' : 'Agents'}
        description={
          startersOnly
            ? 'Choose a starting point for your next agent repository.'
            : 'Develop locally, then deploy versioned agents with the OpenComputer CLI.'
        }
        actions={
          !startersOnly && deployedAgents.length > 0 ? (
            <Button asChild>
              <Link to="/managed-agents/new">
                <Plus />
                Deploy another agent
              </Link>
            </Button>
          ) : undefined
        }
      />

      {showStarters ? (
        <div className="relative overflow-hidden rounded-xl border bg-[radial-gradient(circle_at_top_right,color-mix(in_oklch,var(--primary)_12%,transparent),transparent_45%)] px-6 py-8 sm:px-8">
          <div className="max-w-2xl">
            <div className="bg-primary/10 text-primary mb-4 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium">
              <Sparkles className="size-3.5" />
              {firstRun ? 'Your first agent' : 'Your next agent'}
            </div>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {copy.title}
            </h2>
            <p className="text-muted-foreground mt-3 max-w-xl text-sm leading-6">
              {copy.description}
            </p>
          </div>
        </div>
      ) : null}

      {!startersOnly && agents.isLoading ? (
        <div className="flex min-h-48 items-center justify-center">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      ) : !startersOnly && agents.isError ? (
        <Panel>
          <EmptyState
            icon={Bot}
            title="Your agents are temporarily unavailable"
            description="Try loading the agents page again."
            action={
              <Button variant="outline" onClick={() => void agents.refetch()}>
                Try again
              </Button>
            }
          />
        </Panel>
      ) : !startersOnly && deployedAgents.length > 0 ? (
        <section className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">Your agents</h2>
            <p className="text-muted-foreground text-sm">
              Select an agent to view its deployment and sessions.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {deployedAgents.map((agent) => (
              <Link
                key={agent.id}
                to={`/managed-agents/${encodeURIComponent(agent.id)}`}
                className="group focus-visible:ring-ring/50 rounded-lg outline-none focus-visible:ring-3"
              >
                <Panel className="group-hover:border-foreground/20 group-hover:bg-muted/25 h-full transition-colors">
                  <PanelContent className="flex items-center gap-3">
                    <div className="bg-status-running-bg text-status-running flex size-9 shrink-0 items-center justify-center rounded-full">
                      <Bot className="size-4" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {displayManagedAgentName(agent)}
                      </p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {agent.activeAlias} · {agent.deploymentCount}{' '}
                        {agent.deploymentCount === 1
                          ? 'deployment'
                          : 'deployments'}
                      </p>
                    </div>
                    <ChevronRight className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
                  </PanelContent>
                </Panel>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {showStarters ? (
        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold">{copy.sectionTitle}</h2>
            <p className="text-muted-foreground text-sm">
              {copy.sectionDescription}
            </p>
          </div>

          {templates.isLoading ? (
            <div className="flex min-h-64 items-center justify-center">
              <Loader2 className="text-muted-foreground size-5 animate-spin" />
            </div>
          ) : templates.isError ? (
            <Panel>
              <EmptyState
                icon={Bot}
                title="Agent templates are temporarily unavailable"
                description="Check the managed-agent service configuration and try again."
                action={
                  <Button
                    variant="outline"
                    onClick={() => {
                      void templates.refetch()
                      void agents.refetch()
                    }}
                  >
                    Try again
                  </Button>
                }
              />
            </Panel>
          ) : (
            <>
              <div
                className="bg-muted/30 flex gap-1 overflow-x-auto rounded-lg border p-1"
                role="tablist"
                aria-label="Agent categories"
              >
                {categoryOrder.map((category) => {
                  const Icon = categoryIcons[category]
                  const count = (templates.data ?? []).filter(
                    (template) => template.category === category,
                  ).length
                  return (
                    <button
                      key={category}
                      type="button"
                      role="tab"
                      aria-selected={selectedCategory === category}
                      onClick={() => setSelectedCategory(category)}
                      className={cn(
                        'flex min-w-max flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                        selectedCategory === category
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Icon className="size-3.5" aria-hidden />
                      {category}
                      <span className="text-[10px] opacity-60">{count}</span>
                    </button>
                  )
                })}
              </div>
              <div
                className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
                role="tabpanel"
              >
                {visibleTemplates.map((template) => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    deployed={deployedAgents.some(
                      (agent) => agent.id === template.id,
                    )}
                    copied={copiedTemplateId === template.id}
                    onCopy={() => void copySetupPrompt(template)}
                  />
                ))}
              </div>
            </>
          )}
        </section>
      ) : null}
    </div>
  )
}
