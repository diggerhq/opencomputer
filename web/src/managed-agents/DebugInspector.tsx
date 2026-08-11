import { useState } from 'react'
import {
  Activity,
  Bot,
  Braces,
  Cable,
  ChevronRight,
  FileCode2,
  Wrench,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  managedAgentRenderDebug,
  type ManagedAgentEvent,
  type ManagedAgentRenderDebug,
} from './api'

function eventSummary(event: ManagedAgentEvent) {
  if (event.type === 'runtime.log') {
    return typeof event.data.message === 'string'
      ? event.data.message
      : 'Runtime log'
  }
  if (event.type.startsWith('egress.')) {
    const method =
      typeof event.data.method === 'string' ? event.data.method : 'HTTP'
    const path = typeof event.data.path === 'string' ? event.data.path : ''
    const status =
      typeof event.data.status === 'number' ? ` ${event.data.status}` : ''
    return `${method} ${path}${status}`.trim()
  }
  if (event.type.startsWith('tool.')) {
    return typeof event.data.tool === 'string'
      ? event.data.tool
      : 'Tool activity'
  }
  if (event.type === 'turn.failed' || event.type === 'session.failed') {
    return typeof event.data.message === 'string'
      ? event.data.message
      : 'The runtime reported a failure'
  }
  if (event.type.startsWith('runtime.')) {
    return event.type.replace('runtime.', 'Runtime ')
  }
  return event.type
}

function RuntimeActivity({ events }: { events: ManagedAgentEvent[] }) {
  return (
    <details open className="group bg-background rounded-md border">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium [&::-webkit-details-marker]:hidden">
        <Cable className="size-3.5" /> Runtime logs
        <span className="text-muted-foreground font-mono text-[9px]">
          {events.length}
        </span>
        <ChevronRight className="ml-auto size-3.5 transition-transform group-open:rotate-90" />
      </summary>
      <div className="max-h-72 overflow-y-auto border-t p-3">
        {events.length ? (
          <div className="space-y-2.5">
            {events.map((event) => (
              <div key={event.id ?? `${event.seq}:${event.type}`}>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'font-mono text-[9px]',
                      event.type === 'turn.failed' ||
                        event.type === 'session.failed' ||
                        event.data.level === 'error'
                        ? 'text-destructive'
                        : 'text-muted-foreground',
                    )}
                  >
                    {event.type}
                  </span>
                  <span className="text-muted-foreground ml-auto text-[9px]">
                    {event.timestamp
                      ? new Date(event.timestamp).toLocaleTimeString()
                      : ''}
                  </span>
                </div>
                <p className="mt-0.5 text-xs leading-5 break-words whitespace-pre-wrap">
                  {eventSummary(event)}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            Logs will appear as soon as the runtime starts.
          </p>
        )}
      </div>
    </details>
  )
}

function ResourceList({ values: items }: { values: string[] }) {
  return items.length ? (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={item}
          className="bg-muted rounded px-1.5 py-1 font-mono text-[10px]"
        >
          {item}
        </span>
      ))}
    </div>
  ) : (
    <p className="text-muted-foreground text-xs">None active</p>
  )
}

function RenderChanges({
  current,
  previous,
}: {
  current: ManagedAgentRenderDebug
  previous?: ManagedAgentRenderDebug
}) {
  if (!previous) {
    return <p className="text-muted-foreground text-xs">Initial render</p>
  }
  const addedTools = current.enabledTools.filter(
    (tool) => !previous.enabledTools.includes(tool),
  )
  const removedTools = previous.enabledTools.filter(
    (tool) => !current.enabledTools.includes(tool),
  )
  const changes = [
    ...(current.instructionsHash !== previous.instructionsHash
      ? ['Prompt changed']
      : []),
    ...addedTools.map((tool) => `Tool added: ${tool}`),
    ...removedTools.map((tool) => `Tool removed: ${tool}`),
    ...(JSON.stringify(current.model) !== JSON.stringify(previous.model)
      ? ['Model changed']
      : []),
  ]
  return changes.length ? (
    <ul className="space-y-1 text-xs">
      {changes.map((change) => (
        <li key={change}>{change}</li>
      ))}
    </ul>
  ) : (
    <p className="text-muted-foreground text-xs">
      No prompt, model, or tool changes
    </p>
  )
}

export function DebugInspector({
  events,
  deploymentId,
}: {
  events: ManagedAgentEvent[]
  deploymentId?: string
}) {
  const renders = events.flatMap((event) => {
    const render = managedAgentRenderDebug(event)
    return render ? [{ event, render }] : []
  })
  const [selectedId, setSelectedId] = useState<string>()
  const selected =
    renders.find(({ render }) => render.renderId === selectedId) ??
    (renders.length ? renders[renders.length - 1] : null)
  const actualIndex = selected
    ? renders.findIndex(
        ({ render }) => render.renderId === selected.render.renderId,
      )
    : -1
  const previous =
    actualIndex > 0 ? renders[actualIndex - 1]?.render : undefined
  const activity = events
    .filter(
      (event) =>
        event.type === 'runtime.log' ||
        event.type === 'runtime.connected' ||
        event.type === 'runtime.disconnected' ||
        event.type === 'runtime.suspended' ||
        event.type === 'runtime.resumed' ||
        event.type === 'turn.started' ||
        event.type === 'turn.completed' ||
        event.type === 'turn.failed' ||
        event.type === 'session.failed' ||
        event.type.startsWith('tool.') ||
        event.type.startsWith('egress.'),
    )
    .slice(-50)

  return (
    <aside className="bg-muted/10 min-h-0 overflow-y-auto border-t xl:border-t-0 xl:border-l">
      <div className="border-b px-4 py-3">
        <p className="text-xs font-semibold tracking-wide uppercase">
          Debug inspector
        </p>
        <p className="text-muted-foreground mt-1 truncate font-mono text-[10px]">
          {deploymentId ?? 'Deployment is selected when the session starts'}
        </p>
      </div>

      <div className="space-y-4 p-4">
        {!selected ? (
          <div className="text-muted-foreground flex min-h-40 flex-col items-center justify-center rounded-md border border-dashed px-6 text-center text-sm">
            <Activity className="mb-3 size-6" />
            No reactive render was captured. Check the runtime logs below.
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <p className="text-muted-foreground text-[10px] font-semibold tracking-wide uppercase">
                Renders
              </p>
              <div className="flex flex-wrap gap-1.5">
                {renders.map(({ render }, index) => (
                  <button
                    key={render.renderId}
                    type="button"
                    onClick={() => setSelectedId(render.renderId)}
                    className={cn(
                      'rounded border px-2 py-1 font-mono text-[10px]',
                      render.renderId === selected.render.renderId
                        ? 'border-foreground bg-foreground text-background'
                        : 'bg-background hover:bg-muted',
                    )}
                  >
                    Render {index + 1}
                  </button>
                ))}
              </div>
            </div>

            <div className="bg-background grid grid-cols-2 gap-3 rounded-md border p-3 text-xs">
              <div>
                <p className="text-muted-foreground">Model</p>
                <p className="mt-1 font-mono text-[10px] break-all">
                  {selected.render.model
                    ? `${selected.render.model.provider}/${selected.render.model.model}`
                    : 'Default'}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Provider turn</p>
                <p className="mt-1 font-mono">{selected.render.providerTurn}</p>
              </div>
              <div>
                <p className="text-muted-foreground">State version</p>
                <p className="mt-1 font-mono">{selected.render.stateVersion}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Rendered</p>
                <p className="mt-1 text-[10px]">
                  {new Date(selected.render.renderedAt).toLocaleTimeString()}
                </p>
              </div>
            </div>

            <details open className="group bg-background rounded-md border">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium [&::-webkit-details-marker]:hidden">
                <Bot className="size-3.5" /> Agent prompt
                <ChevronRight className="ml-auto size-3.5 transition-transform group-open:rotate-90" />
              </summary>
              <pre className="max-h-64 overflow-auto border-t p-3 text-xs leading-5 whitespace-pre-wrap">
                {selected.render.instructions || 'No agent instructions'}
              </pre>
            </details>

            <details className="group bg-background rounded-md border">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium [&::-webkit-details-marker]:hidden">
                <Braces className="size-3.5" /> Current input
                <ChevronRight className="ml-auto size-3.5 transition-transform group-open:rotate-90" />
              </summary>
              <div className="border-t p-3 text-xs">
                <p className="text-muted-foreground mb-2 capitalize">
                  {selected.render.input.source}
                </p>
                <p className="whitespace-pre-wrap">
                  {selected.render.input.text ?? 'No text input'}
                </p>
              </div>
            </details>

            <div className="bg-background space-y-3 rounded-md border p-3">
              <div>
                <p className="mb-2 flex items-center gap-2 text-xs font-medium">
                  <Wrench className="size-3.5" /> Available tools
                </p>
                {selected.render.tools.length ? (
                  <div className="space-y-2">
                    {selected.render.tools.map((tool) => (
                      <div key={tool.name}>
                        <p className="font-mono text-[10px]">{tool.name}</p>
                        <p className="text-muted-foreground mt-0.5 text-xs leading-5">
                          {tool.description || 'No description'}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs">None active</p>
                )}
              </div>
              <div>
                <p className="text-muted-foreground mb-1.5 text-[10px] uppercase">
                  Connections
                </p>
                <ResourceList values={selected.render.requiredConnections} />
              </div>
              <div>
                <p className="text-muted-foreground mb-1.5 text-[10px] uppercase">
                  MCP servers
                </p>
                <ResourceList values={selected.render.enabledMcpServers} />
              </div>
              <div>
                <p className="text-muted-foreground mb-1.5 text-[10px] uppercase">
                  Subagents
                </p>
                <ResourceList values={selected.render.enabledSubagents} />
              </div>
              <div>
                <p className="text-muted-foreground mb-1.5 text-[10px] uppercase">
                  Skills
                </p>
                <ResourceList values={[]} />
              </div>
            </div>

            <div className="bg-background rounded-md border p-3">
              <p className="mb-2 flex items-center gap-2 text-xs font-medium">
                <FileCode2 className="size-3.5" /> Changes from previous render
              </p>
              <RenderChanges current={selected.render} previous={previous} />
            </div>
          </>
        )}
        <RuntimeActivity events={activity} />
      </div>
    </aside>
  )
}
