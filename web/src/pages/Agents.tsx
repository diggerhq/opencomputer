import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Plus } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import { getAgents, createAgent, type Agent } from '@/api/client'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/form'
import { EmptyState } from '@/components/empty-state'
import { ResourceTable, type Column } from '@/components/resource-table'

const DEFAULT_MODEL = 'claude-opus-4-8'

export default function Agents() {
  const queryClient = useQueryClient()
  const { data: agents, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: getAgents,
  })

  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState(DEFAULT_MODEL)

  const resetForm = () => {
    setName('')
    setPrompt('')
    setModel(DEFAULT_MODEL)
  }

  const createMutation = useMutation({
    mutationFn: () =>
      createAgent({
        name: name.trim(),
        prompt: prompt.trim(),
        model,
        runtime: 'claude',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      setShowCreate(false)
      resetForm()
    },
    onError: (e) => notifyError("Couldn't create the agent.", e),
  })

  const columns: Column<Agent>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (a) => (
        <span className="text-foreground font-medium">{a.name}</span>
      ),
    },
    {
      key: 'model',
      header: 'Model',
      cell: (a) => (
        <code className="text-muted-foreground font-mono text-xs">
          {a.model}
        </code>
      ),
    },
    {
      key: 'runtime',
      header: 'Runtime',
      cell: (a) => (
        <span className="text-muted-foreground text-xs capitalize">
          {a.runtime}
        </span>
      ),
    },
    {
      key: 'revision',
      header: 'Revision',
      align: 'right',
      cell: (a) => (
        <span className="text-muted-foreground font-mono text-xs">
          {a.revision ?? 1}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      cell: (a) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(a.created_at).toLocaleDateString()}
        </span>
      ),
    },
  ]

  const canCreate = name.trim().length > 0 && prompt.trim().length > 0

  return (
    <div>
      <PageHeader
        title="Agents"
        description="Reusable definitions — a prompt, model, and runtime a session runs."
        actions={
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="size-4" />
            Create agent
          </Button>
        }
      />

      <Panel className="overflow-hidden">
        <ResourceTable
          columns={columns}
          rows={agents ?? []}
          rowKey={(a) => a.id}
          loading={isLoading}
          empty={
            <EmptyState
              icon={Bot}
              title="No agents yet"
              description="An agent is the reusable “what” — define it once, then start sessions from it."
              action={
                <Button size="sm" onClick={() => setShowCreate(true)}>
                  <Plus className="size-4" />
                  Create agent
                </Button>
              }
            />
          }
        />
      </Panel>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create agent</DialogTitle>
            <DialogDescription>
              A reusable definition. Sessions pin a snapshot of it at create
              time.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (canCreate) createMutation.mutate()
            }}
          >
            <Field label="Name" htmlFor="agent-name">
              <Input
                id="agent-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. PR Reviewer"
              />
            </Field>
            <Field
              label="Prompt"
              htmlFor="agent-prompt"
              description="The system prompt that defines how the agent behaves."
            >
              <Textarea
                id="agent-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="You are a meticulous code reviewer…"
                className="min-h-28"
              />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Model" htmlFor="agent-model">
                <Input
                  id="agent-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </Field>
              <Field
                label="Runtime"
                htmlFor="agent-runtime"
                description="Codex and custom runtimes coming soon."
              >
                <Input id="agent-runtime" value="Claude" disabled />
              </Field>
            </div>
            <DialogFooter className="mt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setShowCreate(false)
                  resetForm()
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={createMutation.isPending || !canCreate}
              >
                {createMutation.isPending ? 'Creating…' : 'Create agent'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
