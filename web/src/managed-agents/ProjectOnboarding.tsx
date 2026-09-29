import { useState, type ReactNode } from 'react'
import { Bot, Terminal } from 'lucide-react'
import { CopyRow } from '@/components/copy-row'
import { PageHeader } from '@/components/page-header'
import { cn } from '@/lib/utils'

export const INSTALL_CLI_COMMAND = 'npm i -g @opencomputer/cli'
export const LOGIN_COMMAND = 'opencomputer login'
export const INIT_COMMAND =
  'opencomputer init my-agent && cd my-agent && npm install'
export const DEPLOY_COMMAND =
  'opencomputer deploy --watch --create-project "my-agent"'
export const CREATE_AGENT_PROMPT = `Install the OpenComputer CLI with \`${INSTALL_CLI_COMMAND}\` and run \`${LOGIN_COMMAND}\`. Then, using the OpenComputer CLI, create and deploy my first agent which would [describe what you want it to do].`

type OnboardingPath = 'prompt' | 'commands'

const PATHS: {
  id: OnboardingPath
  title: string
  description: string
  icon: typeof Bot
}[] = [
  {
    id: 'prompt',
    title: 'Use your coding agent',
    description: 'Paste one prompt into Claude Code, Codex, or OpenCode.',
    icon: Bot,
  },
  {
    id: 'commands',
    title: 'Run the commands',
    description: 'Scaffold and deploy a hello-world agent yourself.',
    icon: Terminal,
  },
]

function OnboardingStep({
  number,
  title,
  children,
}: {
  number: number
  title: string
  children: ReactNode
}) {
  return (
    <li className="relative grid grid-cols-[2.5rem_minmax(0,1fr)] gap-5 pb-12 last:pb-0">
      <div className="bg-background z-10 flex size-10 items-center justify-center rounded-full border text-sm font-semibold shadow-sm">
        {number}
      </div>
      <section className="max-w-3xl pt-1" aria-labelledby={`step-${number}`}>
        <h2
          id={`step-${number}`}
          className="text-lg font-semibold tracking-tight"
        >
          {title}
        </h2>
        <div className="text-muted-foreground mt-3 space-y-4 text-sm leading-6">
          {children}
        </div>
      </section>
    </li>
  )
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="before:bg-border relative before:absolute before:top-5 before:bottom-5 before:left-5 before:w-px">
      {children}
    </ol>
  )
}

function PromptPath() {
  return (
    <Steps>
      <OnboardingStep number={1} title="Open your coding agent">
        <p>
          Open a terminal in the directory where you want your agent to live and
          start Claude Code, Codex, or OpenCode.
        </p>
      </OnboardingStep>

      <OnboardingStep number={2} title="Paste this prompt">
        <p>Replace the bracketed text with what you want your agent to do.</p>
        <CopyRow value={CREATE_AGENT_PROMPT} className="bg-background py-3" />
        <p>
          Your coding agent installs the CLI, signs you in, and builds and
          deploys the project. Return here when it finishes to open the project.
        </p>
      </OnboardingStep>
    </Steps>
  )
}

function CommandsPath() {
  return (
    <Steps>
      <OnboardingStep number={1} title="Install the OpenComputer CLI">
        <p>Install the CLI globally with npm.</p>
        <CopyRow value={INSTALL_CLI_COMMAND} className="bg-background py-3" />
      </OnboardingStep>

      <OnboardingStep number={2} title="Sign in to OpenComputer">
        <p>Authenticate the CLI with your OpenComputer account.</p>
        <CopyRow value={LOGIN_COMMAND} className="bg-background py-3" />
      </OnboardingStep>

      <OnboardingStep number={3} title="Create an agent project">
        <p>Scaffold a hello-world agent and install its dependencies.</p>
        <CopyRow value={INIT_COMMAND} className="bg-background py-3" />
      </OnboardingStep>

      <OnboardingStep number={4} title="Deploy it">
        <p>
          Create the cloud project and deploy to Development. The watcher
          redeploys whenever you edit files in <code>opencomputer/</code>.
        </p>
        <CopyRow value={DEPLOY_COMMAND} className="bg-background py-3" />
        <p>Your project appears here after the first deployment.</p>
      </OnboardingStep>
    </Steps>
  )
}

export default function ProjectOnboarding() {
  const [path, setPath] = useState<OnboardingPath>('prompt')

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Create your first agent"
        description="Choose how you want to get started. Your project will appear here after its first deployment."
        className="mb-8"
      />

      <div
        role="tablist"
        aria-label="Getting started path"
        className="mb-10 grid gap-3 sm:grid-cols-2"
      >
        {PATHS.map(({ id, title, description, icon: Icon }) => {
          const selected = path === id
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`onboarding-tab-${id}`}
              aria-selected={selected}
              aria-controls={`onboarding-panel-${id}`}
              onClick={() => setPath(id)}
              className={cn(
                'bg-background flex items-start gap-3 rounded-lg border p-4 text-left transition-colors',
                selected
                  ? 'border-foreground ring-foreground ring-1'
                  : 'hover:bg-muted/50',
              )}
            >
              <Icon className="text-muted-foreground mt-0.5 size-5 shrink-0" />
              <span>
                <span className="block text-sm font-semibold">{title}</span>
                <span className="text-muted-foreground mt-1 block text-sm">
                  {description}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <div
        role="tabpanel"
        id={`onboarding-panel-${path}`}
        aria-labelledby={`onboarding-tab-${path}`}
      >
        {path === 'prompt' ? <PromptPath /> : <CommandsPath />}
      </div>
    </div>
  )
}
