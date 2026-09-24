import { ArrowRight, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { FirstSessionStep } from './first-session-guide'

export function FirstSessionGuide({ steps }: { steps: FirstSessionStep[] }) {
  return (
    <section
      aria-label="What to do next"
      className="bg-muted/30 max-w-3xl rounded-xl border p-4"
    >
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Sparkles className="size-3.5" aria-hidden /> Your first session worked.
        Here&apos;s where to take it next
      </p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {steps.map((step) => {
          const body = (
            <>
              <span className="flex items-center gap-1 text-xs font-medium">
                {step.title}
                {step.to ? (
                  <ArrowRight
                    className="size-3 opacity-60 transition-transform group-hover:translate-x-0.5"
                    aria-hidden
                  />
                ) : null}
              </span>
              <span className="text-muted-foreground mt-1 block text-xs leading-5">
                {step.description}
              </span>
              {step.command ? (
                <code className="bg-background mt-1.5 block w-fit rounded px-1.5 py-0.5 font-mono text-[11px]">
                  {step.command}
                </code>
              ) : null}
            </>
          )
          return (
            <li key={step.id} className="min-w-0">
              {step.to ? (
                <Link
                  to={step.to}
                  className="group bg-background hover:border-ring/60 block h-full rounded-lg border p-3 transition-colors"
                >
                  {body}
                </Link>
              ) : (
                <div className="bg-background block h-full rounded-lg border p-3">
                  {body}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
