import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, KeySquare, Plus } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import {
  createCredential,
  deleteCredential,
  getCredentials,
  setDefaultCredential,
  type Credential,
} from '@/api/client'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, Input, Label, Select } from '@/components/form'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ResourceTable, type Column } from '@/components/resource-table'
import { StepProgress } from '@/components/step-progress'

// Providers an agent runtime can use. claude → anthropic; openai lands when the
// codex runtime ships, but a key can be stored ahead of it.
const PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
]
const KEY_HINT: Record<string, string> = {
  anthropic: 'sk-ant-…',
  openai: 'sk-…',
}

// The real phases a create runs through (reserve a ref → write to the secret
// store → activate). We surface them so the wait reads as a job, not a hang.
const CREATE_STEPS = [
  'Securing your key',
  'Provisioning in secure secret store',
  'Finalizing credential',
]
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export default function Credentials() {
  const queryClient = useQueryClient()
  const { data: credentials, isLoading } = useQuery({
    queryKey: ['credentials'],
    queryFn: getCredentials,
  })

  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [provider, setProvider] = useState('anthropic')
  const [key, setKey] = useState('')
  const [makeDefault, setMakeDefault] = useState(true)
  const [toDelete, setToDelete] = useState<Credential | null>(null)

  const resetForm = () => {
    setName('')
    setProvider('anthropic')
    setKey('')
    setMakeDefault(true)
  }

  // Two strategies for the slow edge → sessions-api → Infisical chain:
  //  - delete / set-default: OPTIMISTIC — apply to the cache instantly, roll back
  //    on failure (no provisioning, nothing real to wait on).
  //  - create: provisions a secret in the store, so rather than hide the wait we
  //    SHOW it as a stepped job (reserve → provision → finalize).
  const CREDS_KEY = ['credentials'] as const
  const snapshot = async () => {
    await queryClient.cancelQueries({ queryKey: CREDS_KEY })
    return queryClient.getQueryData<Credential[]>(CREDS_KEY)
  }
  const rollback = (previous?: Credential[]) => {
    if (previous) queryClient.setQueryData(CREDS_KEY, previous)
  }

  // Create progress: 'form' shows the inputs; 'running' shows the step checklist.
  const [phase, setPhase] = useState<'form' | 'running'>('form')
  const [step, setStep] = useState(0)
  const [createError, setCreateError] = useState<string | null>(null)
  const provisionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const createMutation = useMutation({
    mutationFn: () =>
      createCredential({
        key: key.trim(),
        provider,
        name: name.trim() || undefined,
        is_default: makeDefault,
      }),
    onMutate: () => {
      setCreateError(null)
      setPhase('running')
      setStep(0) // "Securing your key"
      // The reserve is fast; the write to the secret store is the long pole — hold
      // the active spinner on it until the request actually resolves.
      provisionTimer.current = setTimeout(() => setStep(1), 450)
    },
    onSuccess: async () => {
      if (provisionTimer.current) clearTimeout(provisionTimer.current)
      setStep(2) // "Finalizing credential"
      await wait(300)
      setStep(CREATE_STEPS.length) // all done
      await queryClient.invalidateQueries({ queryKey: CREDS_KEY })
      await wait(550) // let the completed checklist register before closing
      setShowCreate(false)
      setPhase('form')
      setStep(0)
      resetForm()
    },
    onError: (e) => {
      if (provisionTimer.current) clearTimeout(provisionTimer.current)
      // Back to the form with inputs intact + an inline error, so they can retry.
      setPhase('form')
      setCreateError(
        e instanceof Error ? e.message : "Couldn't add the credential.",
      )
    },
  })

  const defaultMutation = useMutation({
    mutationFn: (id: string) => setDefaultCredential(id),
    onMutate: async (id) => {
      const previous = await snapshot()
      const target = previous?.find((c) => c.id === id)
      queryClient.setQueryData<Credential[]>(CREDS_KEY, (old = []) =>
        old.map((c) =>
          c.provider === target?.provider
            ? { ...c, is_default: c.id === id }
            : c,
        ),
      )
      return { previous }
    },
    onError: (e, _id, ctx) => {
      rollback(ctx?.previous)
      notifyError("Couldn't set the default.", e)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: CREDS_KEY }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCredential(id),
    onMutate: async (id) => {
      const previous = await snapshot()
      queryClient.setQueryData<Credential[]>(CREDS_KEY, (old = []) =>
        old.filter((c) => c.id !== id),
      )
      setToDelete(null) // dismiss the confirm immediately
      return { previous }
    },
    onError: (e, _id, ctx) => {
      rollback(ctx?.previous)
      notifyError("Couldn't delete the credential.", e)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: CREDS_KEY }),
  })

  const openCreate = () => {
    setPhase('form')
    setStep(0)
    setCreateError(null)
    setShowCreate(true)
  }
  const closeCreate = () => {
    setShowCreate(false)
    setPhase('form')
    setStep(0)
    setCreateError(null)
    resetForm()
  }

  const columns: Column<Credential>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (c) => (
        <span className="flex items-center gap-2">
          <span className="text-foreground font-medium">
            {c.name || <span className="text-muted-foreground">Unnamed</span>}
          </span>
          {c.is_default ? <Badge variant="secondary">Default</Badge> : null}
        </span>
      ),
    },
    {
      key: 'provider',
      header: 'Provider',
      cell: (c) => (
        <span className="text-muted-foreground text-xs capitalize">
          {c.provider}
        </span>
      ),
    },
    {
      key: 'key',
      header: 'Key',
      cell: (c) => (
        <code className="text-muted-foreground font-mono text-xs">
          {c.last4 ? `··· ${c.last4}` : '—'}
        </code>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      cell: (c) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(c.created_at).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (c) => (
        <div className="flex items-center justify-end gap-1">
          {!c.is_default ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={defaultMutation.isPending}
              onClick={() => defaultMutation.mutate(c.id)}
            >
              Set default
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="text-status-error underline-offset-2 hover:bg-transparent hover:underline"
            onClick={() => setToDelete(c)}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ]

  const canCreate = key.trim().length > 0

  return (
    <div>
      <PageHeader
        title="Credentials"
        description="Model-provider keys your agents run on. Stored write-only; pick one per agent or set an org default."
        api={{
          method: 'POST',
          path: '/v3/credentials',
          sdk: 'oc.credentials.create()',
          docs: 'https://docs.opencomputer.dev/agent-sessions/credentials',
        }}
        actions={
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            Add credential
          </Button>
        }
      />

      <Panel className="overflow-hidden">
        <ResourceTable
          columns={columns}
          rows={credentials ?? []}
          rowKey={(c) => c.id}
          loading={isLoading}
          empty={
            <EmptyState
              icon={KeySquare}
              title="No credentials yet"
              description="Add a model-provider key once, then reuse it across agents — no need to paste it every time."
              action={
                <Button size="sm" onClick={openCreate}>
                  <Plus className="size-4" />
                  Add credential
                </Button>
              }
            />
          }
        />
      </Panel>

      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          if (phase === 'running') return // lock the dialog while the job runs
          if (open) openCreate()
          else closeCreate()
        }}
      >
        <DialogContent>
          {phase === 'running' ? (
            <div className="space-y-5">
              <DialogHeader>
                <DialogTitle>
                  {step >= CREATE_STEPS.length
                    ? 'Credential ready'
                    : 'Adding credential'}
                </DialogTitle>
                <DialogDescription>
                  {step >= CREATE_STEPS.length
                    ? 'Stored in your secure secret store.'
                    : 'Provisioning it in your secure secret store — just a moment.'}
                </DialogDescription>
              </DialogHeader>
              {step >= CREATE_STEPS.length ? (
                <div className="flex items-center gap-3 py-1 text-sm">
                  <CircleCheck className="text-status-running size-5 shrink-0" />
                  <span className="text-foreground">
                    {name.trim() || 'Credential'} added
                    {makeDefault ? ' · set as default' : ''}.
                  </span>
                </div>
              ) : (
                <StepProgress steps={CREATE_STEPS} current={step} />
              )}
            </div>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Add credential</DialogTitle>
                <DialogDescription>
                  The key is stored write-only — you won&apos;t be able to read
                  it back, only rotate or delete it.
                </DialogDescription>
              </DialogHeader>
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (canCreate) createMutation.mutate()
                }}
              >
                {createError ? (
                  <div className="border-status-error/30 bg-status-error-bg text-status-error rounded-md border px-3 py-2 text-xs">
                    {createError}
                  </div>
                ) : null}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Name" htmlFor="cred-name">
                    <Input
                      id="cred-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Production"
                    />
                  </Field>
                  <Field label="Provider" htmlFor="cred-provider">
                    <Select
                      id="cred-provider"
                      value={provider}
                      onValueChange={setProvider}
                      options={PROVIDERS}
                    />
                  </Field>
                </div>
                <Field label="API key" htmlFor="cred-key">
                  <Input
                    id="cred-key"
                    type="password"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder={KEY_HINT[provider] ?? 'sk-…'}
                  />
                </Field>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="cred-default"
                    checked={makeDefault}
                    onCheckedChange={(v) => setMakeDefault(v === true)}
                  />
                  <Label
                    htmlFor="cred-default"
                    className="cursor-pointer font-normal"
                  >
                    Set as the org default for {provider}
                    <span className="text-muted-foreground">
                      {' '}
                      — used when an agent doesn&apos;t pin its own.
                    </span>
                  </Label>
                </div>
                <DialogFooter className="mt-2">
                  <Button type="button" variant="ghost" onClick={closeCreate}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={!canCreate}>
                    Add credential
                  </Button>
                </DialogFooter>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title={`Delete ${toDelete?.name ? `"${toDelete.name}"` : 'this credential'}?`}
        description="Agents pinned to it, and sessions that fall back to it, will stop running until you point them at another credential. This can't be undone."
        confirmLabel="Delete credential"
        destructive
        onConfirm={() => {
          if (toDelete) deleteMutation.mutate(toDelete.id)
        }}
      />
    </div>
  )
}
