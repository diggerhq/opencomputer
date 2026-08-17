// Agent Evals tab — native input/output evals for a deployed agent. A dataset is a set of
// { input, expect } examples; a run executes each as an isolated session against the agent and
// scores the output. Runtime-agnostic (drives the /v3 session API), so flue/langgraph/claude/
// codex/pi are all just "the agent under test". Backed by api-edge + D1 (see src/api/evals.ts).
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FlaskConical, Play, Plus, Trash2, ChevronLeft, Pencil } from 'lucide-react'
import {
  Panel,
  PanelHeader,
  PanelTitle,
  PanelDescription,
  PanelContent,
  PanelFooter,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/form'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ResourceTable, type Column } from '@/components/resource-table'
import { notifyError } from '@/lib/errors'
import {
  createEvalDataset,
  createEvalRun,
  deleteEvalDataset,
  getEvalDatasets,
  getEvalResults,
  getEvalRuns,
  updateEvalDataset,
  type EvalDataset,
  type EvalExample,
  type EvalExpect,
  type EvalResult,
  type EvalRun,
} from '@/api/evals'

const EXAMPLES_PLACEHOLDER = `[
  { "input": "What is 2 + 2?", "expect": { "contains": ["4"] } },
  { "input": "Capital of France?", "expect": { "contains": ["Paris"], "max_cost_usd": 0.05 } }
]`

const runBadge = (s: EvalRun['status']) =>
  s === 'done' ? 'success' : s === 'failed' ? 'error' : s === 'running' ? 'running' : 'pending'

/** Human-readable summary of an example's checks. */
function expectSummary(e?: EvalExpect): string {
  if (!e) return 'no checks'
  const parts: string[] = []
  if (e.contains?.length) parts.push(`contains ${e.contains.map((s) => JSON.stringify(s)).join(', ')}`)
  if (e.equals !== undefined) parts.push(`equals ${JSON.stringify(e.equals)}`)
  if (e.iregex !== undefined) parts.push(`regex /${e.iregex}/i`)
  if (e.outcome !== undefined) parts.push(`outcome=${e.outcome}`)
  if (e.tools?.length) parts.push(`tools ${e.tools.join(', ')}`)
  if (e.max_cost_usd !== undefined) parts.push(`cost ≤ $${e.max_cost_usd}`)
  return parts.length ? parts.join(' · ') : 'no checks'
}

export function AgentEvals({ agentId }: { agentId: string }) {
  const [selectedDataset, setSelectedDataset] = useState<string | null>(null)
  const [selectedRun, setSelectedRun] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const datasetsQuery = useQuery({
    queryKey: ['eval-datasets', agentId],
    queryFn: () => getEvalDatasets(agentId),
  })
  const datasets = datasetsQuery.data ?? []

  if (selectedRun && selectedDataset) {
    return <RunResults runId={selectedRun} onBack={() => setSelectedRun(null)} />
  }
  if (selectedDataset) {
    return (
      <DatasetDetail
        agentId={agentId}
        dataset={datasets.find((d) => d.id === selectedDataset)}
        datasetId={selectedDataset}
        onBack={() => setSelectedDataset(null)}
        onOpenRun={(id) => setSelectedRun(id)}
      />
    )
  }

  return (
    <Panel className="overflow-hidden">
      <PanelHeader>
        <div>
          <PanelTitle>Evals</PanelTitle>
          <PanelDescription className="mt-1">
            Input/output eval sets for this agent. Each run executes every example as an isolated
            session and scores the output — the same for any runtime.
          </PanelDescription>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="mr-1 h-4 w-4" /> New dataset
        </Button>
      </PanelHeader>

      {creating ? (
        <DatasetForm
          agentId={agentId}
          onDone={() => setCreating(false)}
          onCancel={() => setCreating(false)}
        />
      ) : null}

      <ResourceTable<EvalDataset>
        columns={datasetColumns(setSelectedDataset)}
        rows={datasets}
        rowKey={(d) => d.id}
        loading={datasetsQuery.isLoading}
        empty={
          <EmptyState
            icon={FlaskConical}
            title="No eval datasets yet"
            description="Create a dataset of inputs + expectations, then run it to score the agent."
          />
        }
      />
    </Panel>
  )
}

function datasetColumns(select: (id: string) => void): Column<EvalDataset>[] {
  return [
    {
      key: 'name',
      header: 'Dataset',
      cell: (d) => (
        <button
          className="text-foreground hover:text-primary text-left font-medium"
          onClick={() => select(d.id)}
        >
          {d.name}
        </button>
      ),
    },
    {
      key: 'examples',
      header: 'Examples',
      cell: (d) => <span className="text-muted-foreground text-sm">{d.examples.length}</span>,
    },
    {
      key: 'open',
      header: '',
      cell: (d) => (
        <Button size="sm" variant="outline" onClick={() => select(d.id)}>
          Open
        </Button>
      ),
    },
  ]
}

/** Create OR edit a dataset. `dataset` present → edit mode (pre-filled, PATCH); else create. */
function DatasetForm({
  agentId,
  dataset,
  onDone,
  onCancel,
}: {
  agentId: string
  dataset?: EvalDataset
  onDone: () => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(dataset?.name ?? '')
  const [text, setText] = useState(
    dataset ? JSON.stringify(dataset.examples.map((e) => ({ input: e.input, expect: e.expect })), null, 2) : '',
  )
  const [parseError, setParseError] = useState<string | null>(null)

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['eval-datasets', agentId] })
  const mutation = useMutation({
    mutationFn: (examples: EvalExample[]) =>
      dataset
        ? updateEvalDataset(dataset.id, { name: name.trim() || 'Untitled', examples })
        : createEvalDataset({ agent_id: agentId, name: name.trim() || 'Untitled', examples }),
    onSuccess: () => {
      invalidate()
      onDone()
    },
    onError: (e) => notifyError(dataset ? "Couldn't save the dataset." : "Couldn't create the dataset.", e),
  })

  const submit = () => {
    setParseError(null)
    let examples: { input: string; expect?: unknown }[]
    try {
      const parsed: unknown = JSON.parse(text || '[]')
      if (!Array.isArray(parsed)) throw new Error('examples must be a JSON array')
      examples = parsed as { input: string; expect?: unknown }[]
      if (!examples.every((e) => typeof e?.input === 'string' && e.input.trim())) {
        throw new Error('each example needs a non-empty "input"')
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'invalid JSON')
      return
    }
    mutation.mutate(
      examples.map((e) => ({
        id: crypto.randomUUID(),
        input: e.input,
        ...(e.expect && typeof e.expect === 'object' ? { expect: e.expect as EvalExpect } : {}),
      })),
    )
  }

  return (
    <PanelContent className="border-b">
      <div className="space-y-3">
        <Field label="Name" htmlFor="eval-name">
          <Input
            id="eval-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. smoke suite"
          />
        </Field>
        <Field label="Examples (JSON)" htmlFor="eval-examples">
          <Textarea
            id="eval-examples"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={EXAMPLES_PLACEHOLDER}
            rows={10}
            className="font-mono text-xs"
          />
        </Field>
        <p className="text-muted-foreground text-xs">
          expect keys: <code>contains</code>, <code>equals</code>, <code>iregex</code>,{' '}
          <code>tools</code>, <code>outcome</code>, <code>max_cost_usd</code>.
        </p>
        {parseError ? <p className="text-status-error text-xs">{parseError}</p> : null}
        <div className="flex gap-2">
          <Button size="sm" onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : dataset ? 'Save changes' : 'Create dataset'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </PanelContent>
  )
}

function DatasetDetail({
  agentId,
  dataset,
  datasetId,
  onBack,
  onOpenRun,
}: {
  agentId: string
  dataset: EvalDataset | undefined
  datasetId: string
  onBack: () => void
  onOpenRun: (runId: string) => void
}) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const runsQuery = useQuery({
    queryKey: ['eval-runs', datasetId],
    queryFn: () => getEvalRuns(datasetId),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((r) => r.status === 'pending' || r.status === 'running') ? 2000 : false,
  })
  const runs = runsQuery.data ?? []

  const runMutation = useMutation({
    mutationFn: () => createEvalRun(datasetId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['eval-runs', datasetId] }),
    onError: (e) => notifyError("Couldn't start the run.", e),
  })
  const deleteMutation = useMutation({
    mutationFn: () => deleteEvalDataset(datasetId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['eval-datasets', agentId] })
      onBack()
    },
    onError: (e) => notifyError("Couldn't delete the dataset.", e),
  })

  const runColumns: Column<EvalRun>[] = [
    {
      key: 'run',
      header: 'Run',
      cell: (r) => (
        <button className="text-foreground hover:text-primary font-mono text-xs" onClick={() => onOpenRun(r.id)}>
          {r.id}
        </button>
      ),
    },
    { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={runBadge(r.status)} label={r.status} /> },
    {
      key: 'score',
      header: 'Score',
      cell: (r) => (
        <span className="text-sm font-medium">{r.score == null ? '—' : `${Math.round(r.score * 100)}%`}</span>
      ),
    },
    { key: 'progress', header: 'Progress', cell: (r) => <span className="text-muted-foreground text-xs">{r.completed}/{r.total}</span> },
  ]

  const examples = dataset?.examples ?? []

  return (
    <div className="space-y-4">
      <Panel className="overflow-hidden">
        <PanelHeader>
          <div className="min-w-0">
            <button className="text-muted-foreground hover:text-foreground mb-1 flex items-center text-xs" onClick={onBack}>
              <ChevronLeft className="h-3 w-3" /> All datasets
            </button>
            <PanelTitle>{dataset?.name ?? 'Dataset'}</PanelTitle>
            <PanelDescription className="mt-1">
              {examples.length} example{examples.length === 1 ? '' : 's'} · runs execute each as a session and score the output.
            </PanelDescription>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing((v) => !v)}>
              <Pencil className="mr-1 h-4 w-4" /> {editing ? 'Close' : 'Edit'}
            </Button>
            <Button size="sm" onClick={() => runMutation.mutate()} disabled={runMutation.isPending}>
              <Play className="mr-1 h-4 w-4" /> {runMutation.isPending ? 'Starting…' : 'Run evals'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => deleteMutation.mutate()} disabled={deleteMutation.isPending}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </PanelHeader>

        {editing && dataset ? (
          <DatasetForm agentId={agentId} dataset={dataset} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
        ) : (
          <PanelContent>
            <ul className="divide-y">
              {examples.map((ex, i) => (
                <li key={ex.id} className="py-2.5">
                  <div className="flex items-start gap-2">
                    <span className="text-muted-foreground/70 mt-0.5 font-mono text-[10px]">{i + 1}</span>
                    <div className="min-w-0">
                      <p className="text-foreground text-sm">{ex.input}</p>
                      <p className="text-muted-foreground mt-0.5 font-mono text-[11px]">{expectSummary(ex.expect)}</p>
                    </div>
                  </div>
                </li>
              ))}
              {examples.length === 0 ? <li className="text-muted-foreground py-2 text-xs">No examples — click Edit to add some.</li> : null}
            </ul>
          </PanelContent>
        )}
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader>
          <PanelTitle>Runs</PanelTitle>
        </PanelHeader>
        <ResourceTable<EvalRun>
          columns={runColumns}
          rows={runs}
          rowKey={(r) => r.id}
          loading={runsQuery.isLoading}
          empty={<EmptyState icon={Play} title="No runs yet" description="Run this dataset to score the agent's current behavior." />}
        />
      </Panel>
    </div>
  )
}

function RunResults({ runId, onBack }: { runId: string; onBack: () => void }) {
  const resultsQuery = useQuery({
    queryKey: ['eval-results', runId],
    queryFn: () => getEvalResults(runId),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((r) => r.state === 'pending' || r.state === 'running') ? 2000 : false,
  })
  const results = resultsQuery.data ?? []

  return (
    <Panel className="overflow-hidden">
      <PanelHeader>
        <div>
          <button className="text-muted-foreground hover:text-foreground mb-1 flex items-center text-xs" onClick={onBack}>
            <ChevronLeft className="h-3 w-3" /> Back to runs
          </button>
          <PanelTitle>Results</PanelTitle>
          <PanelDescription className="mt-1">Per-example output + score. Each row is one isolated session.</PanelDescription>
        </div>
      </PanelHeader>
      <PanelContent>
        {resultsQuery.isLoading ? (
          <p className="text-muted-foreground text-xs">Loading…</p>
        ) : results.length === 0 ? (
          <p className="text-muted-foreground text-xs">No results.</p>
        ) : (
          <ul className="divide-y">
            {results.map((r) => (
              <ResultRow key={r.id} result={r} />
            ))}
          </ul>
        )}
      </PanelContent>
      <PanelFooter>
        <span className="text-muted-foreground text-xs">
          {results.filter((r) => r.passed === 1).length}/{results.length} passing
        </span>
      </PanelFooter>
    </Panel>
  )
}

function ResultRow({ result: r }: { result: EvalResult }) {
  const running = r.state === 'pending' || r.state === 'running'
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge
          status={running ? 'running' : r.passed === 1 ? 'success' : 'error'}
          label={running ? r.state : r.passed === 1 ? 'pass' : 'fail'}
        />
        <span className="text-foreground truncate text-sm font-medium">{r.input}</span>
        {r.outcome ? <span className="text-muted-foreground/80 font-mono text-[11px]">outcome: {r.outcome}</span> : null}
        {r.cost_usd != null ? <span className="text-muted-foreground/80 font-mono text-[11px]">${r.cost_usd.toFixed(4)}</span> : null}
      </div>
      {r.scores.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {r.scores.map((s) => (
            <span
              key={s.name}
              className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                s.pass ? 'bg-status-success/10 text-status-success' : 'bg-status-error/10 text-status-error'
              }`}
              title={s.detail}
            >
              {s.pass ? '✓' : '✗'} {s.name}
            </span>
          ))}
        </div>
      ) : null}
      {r.output ? <p className="text-foreground/80 mt-1.5 line-clamp-3 text-sm whitespace-pre-wrap">{r.output}</p> : null}
      {r.error ? <p className="text-status-error mt-1 font-mono text-[11px]">{r.error}</p> : null}
    </li>
  )
}
