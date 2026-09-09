import type { ReactNode } from 'react'
import { CopyRow } from '@/components/copy-row'
import { PageHeader } from '@/components/page-header'

export const INSTALL_CLI_COMMAND = 'npm i -g @opencomputer/cli'
export const LOGIN_COMMAND = 'opencomputer login'
export const CREATE_AGENT_PROMPT =
  'Using the OpenComputer CLI, create my first agent which would [describe what you want it to do].'

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

export default function ProjectOnboarding() {
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Create your first agent"
        description="Start in your local workspace. Your project will appear here after its first deployment."
        className="mb-10"
      />

      <ol className="before:bg-border relative before:absolute before:top-5 before:bottom-5 before:left-5 before:w-px">
        <OnboardingStep number={1} title="Install the OpenComputer CLI">
          <p>Install the CLI globally with npm.</p>
          <CopyRow value={INSTALL_CLI_COMMAND} className="bg-background py-3" />
        </OnboardingStep>

        <OnboardingStep number={2} title="Sign in to OpenComputer">
          <p>
            Open a terminal in the directory where you want your agent to live,
            then authenticate the CLI.
          </p>
          <CopyRow value={LOGIN_COMMAND} className="bg-background py-3" />
        </OnboardingStep>

        <OnboardingStep number={3} title="Create your first agent">
          <p>
            Open Codex, Claude Code, or OpenCode in that directory and paste
            this prompt. Replace the bracketed text with what you want your
            agent to do.
          </p>
          <CopyRow value={CREATE_AGENT_PROMPT} className="bg-background py-3" />
          <p>
            Your coding agent will guide you through creating and deploying the
            project with the OpenComputer CLI. Return here when it finishes to
            open the project.
          </p>
        </OnboardingStep>
      </ol>
    </div>
  )
}
