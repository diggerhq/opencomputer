import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  Bot,
  BriefcaseBusiness,
  Check,
  Clipboard,
  ClipboardCheck,
  Lightbulb,
  Loader2,
  MessageSquareText,
  Send,
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
  getManagedAgents,
  getManagedAgentTemplates,
  invokeManagedAgent,
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

const categoryIcons = {
  Comms: MessageSquareText,
  Operations: Workflow,
  Admin: BriefcaseBusiness,
  Growth: TrendingUp,
  Insights: Lightbulb,
} satisfies Record<Category, typeof Sparkles>

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
5. Inspect and tailor the checked-in source: \`opencomputer.toml\`, \`instructions.md\`, \`agent.ts\`, \`tools/\`, \`connections/\`, \`channels/\`, \`skills/\`, \`workspace/\`, and \`evals/\`.
6. Keep the stable \`id\` in \`opencomputer.toml\`; future deployments of this repository must create new versions of that same agent.
7. Add and authorize only supported integrations. For Gmail, use \`opencomputer tools add gmail\` and \`${cliCommand(origin, 'connect google')}\`. For Slack, use \`opencomputer channels add slack\`.
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
          {copied ? 'Setup prompt copied' : 'Copy setup prompt'}
        </Button>
      </PanelContent>
    </Panel>
  )
}

export default function ManagedAgentsHome() {
  const [selectedCategory, setSelectedCategory] = useState<Category>('Comms')
  const [copiedTemplateId, setCopiedTemplateId] = useState<string>()
  const [selectedAgentId, setSelectedAgentId] = useState<string>()
  const [prompt, setPrompt] = useState('')
  const [lastResponse, setLastResponse] = useState('')
  const templates = useQuery({
    queryKey: ['managed-agent-templates'],
    queryFn: getManagedAgentTemplates,
  })
  const agents = useQuery({
    queryKey: ['managed-agents'],
    queryFn: getManagedAgents,
  })
  const invoke = useMutation({
    mutationFn: ({ agentId, input }: { agentId: string; input: string }) =>
      invokeManagedAgent(agentId, input),
    onSuccess: (result) => setLastResponse(result.output),
    onError: (error) => notifyError("Couldn't run this agent.", error),
  })

  const loading = templates.isLoading || agents.isLoading
  const failed = templates.isError || agents.isError
  const deployedAgents = agents.data ?? []
  const firstRun = !loading && deployedAgents.length === 0
  const activeAgentId = selectedAgentId ?? deployedAgents[0]?.id
  const visibleTemplates = useMemo(
    () =>
      (templates.data ?? []).filter(
        (template) => template.category === selectedCategory,
      ),
    [selectedCategory, templates.data],
  )

  async function copySetupPrompt(template: ManagedAgentTemplate) {
    try {
      await navigator.clipboard.writeText(
        buildSetupPrompt(template, window.location.origin),
      )
      setCopiedTemplateId(template.id)
      toast.success(`${template.name} setup prompt copied`)
    } catch (error) {
      notifyError("Couldn't copy the setup prompt.", error)
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Agents"
        description="Start from source, develop locally with OpenCode, then deploy versioned agents with the OpenComputer CLI."
      />

      {firstRun ? (
        <div className="relative overflow-hidden rounded-xl border bg-[radial-gradient(circle_at_top_right,color-mix(in_oklch,var(--primary)_12%,transparent),transparent_45%)] px-6 py-8 sm:px-8">
          <div className="max-w-2xl">
            <div className="bg-primary/10 text-primary mb-4 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium">
              <Sparkles className="size-3.5" />
              Your first agent
            </div>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Pick a job. Create the agent repository.
            </h2>
            <p className="text-muted-foreground mt-3 max-w-xl text-sm leading-6">
              Copy a ready-to-run setup prompt into Codex, Claude Code, or
              OpenCode. It will create editable source, install its OpenCode
              packages, test it locally, and deploy it through the OpenComputer
              CLI.
            </p>
            <code className="bg-muted text-muted-foreground mt-5 inline-block rounded-md border px-3 py-2 font-mono text-xs">
              opencomputer init email-triage
            </code>
          </div>
        </div>
      ) : null}

      {deployedAgents.length > 0 ? (
        <section className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">Your agents</h2>
            <p className="text-muted-foreground text-sm">
              Managed deployments available to your organization.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {deployedAgents.map((agent) => (
              <Panel
                key={agent.id}
                className={cn(
                  activeAgentId === agent.id && 'border-primary/40',
                )}
              >
                <PanelContent className="flex items-center gap-3">
                  <div className="bg-status-running-bg text-status-running flex size-9 shrink-0 items-center justify-center rounded-full">
                    <Bot className="size-4" aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm font-medium">
                      {agent.id}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {agent.activeAlias} · {agent.deploymentCount}{' '}
                      {agent.deploymentCount === 1
                        ? 'deployment'
                        : 'deployments'}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={
                      activeAgentId === agent.id ? 'secondary' : 'outline'
                    }
                    onClick={() => {
                      setSelectedAgentId(agent.id)
                      setLastResponse('')
                    }}
                  >
                    Test
                  </Button>
                </PanelContent>
              </Panel>
            ))}
          </div>
          {activeAgentId ? (
            <Panel className="mt-4">
              <PanelHeader>
                <div>
                  <PanelTitle>Test {activeAgentId}</PanelTitle>
                  <PanelDescription className="mt-1">
                    Start a managed run without leaving the agent experience.
                  </PanelDescription>
                </div>
              </PanelHeader>
              <PanelContent className="space-y-3">
                <label
                  htmlFor="managed-agent-prompt"
                  className="text-sm font-medium"
                >
                  Message
                </label>
                <textarea
                  id="managed-agent-prompt"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Ask your agent to do something…"
                  rows={3}
                  className="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full resize-y rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-3"
                />
                <div className="flex justify-end">
                  <Button
                    disabled={!prompt.trim() || invoke.isPending}
                    onClick={() => {
                      setLastResponse('')
                      invoke.mutate({
                        agentId: activeAgentId,
                        input: prompt.trim(),
                      })
                    }}
                  >
                    {invoke.isPending ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Send />
                    )}
                    {invoke.isPending ? 'Agent is working…' : 'Run agent'}
                  </Button>
                </div>
                {lastResponse ? (
                  <div className="bg-muted/60 rounded-md border px-4 py-3">
                    <p className="text-muted-foreground mb-2 text-[10px] font-medium tracking-wider uppercase">
                      Response
                    </p>
                    <p className="text-sm leading-6 whitespace-pre-wrap">
                      {lastResponse}
                    </p>
                  </div>
                ) : null}
              </PanelContent>
            </Panel>
          ) : null}
        </section>
      ) : null}

      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold">Agent starters</h2>
          <p className="text-muted-foreground text-sm">
            Copy a ready-to-run setup prompt for your coding agent.
          </p>
        </div>

        {loading ? (
          <div className="flex min-h-64 items-center justify-center">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : failed ? (
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
              {categories.map((category) => {
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
    </div>
  )
}
