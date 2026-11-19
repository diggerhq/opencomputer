import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { Field, Input, Select } from '@/components/form'
import { Button } from '@/components/ui/button'
import { notifyError, notifySuccess } from '@/lib/errors'
import { computerQueryKey, getComputer } from '../computer-api'
import {
  getRepository,
  putRepository,
  useOrg,
  workKeys,
  type Repository,
} from './api'
import { repositoryName, repositoryProblem } from './board'

// Which repository holds the organization's working docs (tech design 3.1):
// one per organization, chosen from what its GitHub connection can reach.

export function WorkRepositorySetting({ id }: { id?: string }) {
  const org = useOrg()
  const repository = useQuery({
    queryKey: workKeys.repository(org),
    queryFn: getRepository,
  })
  const [editing, setEditing] = useState(false)
  const current = repository.data ?? null

  return (
    <section id={id} aria-labelledby="work-repository">
      <h2 id="work-repository" className="mb-3 text-sm font-semibold">
        Working docs
      </h2>
      <div className="bg-panel rounded-lg border px-5 py-3 text-sm">
        {repository.isPending ? (
          <Loader2
            className="text-muted-foreground size-4 animate-spin"
            aria-label="Loading"
          />
        ) : repository.isError ? (
          <p className="text-muted-foreground">
            Working docs are not available here yet.
          </p>
        ) : editing || !current ? (
          <RepositoryForm
            current={current}
            onDone={() => setEditing(false)}
            onCancel={current ? () => setEditing(false) : undefined}
          />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium">
                {repositoryName(current)}
                <span className="text-muted-foreground font-normal">
                  {' '}
                  · {current.branch}
                </span>
              </p>
              {current.problem ? (
                <p className="text-status-error">
                  {repositoryProblem(current)}
                </p>
              ) : (
                <p className="text-muted-foreground">
                  Tracked items live here and show on the{' '}
                  <Link
                    to="/computer/work"
                    className="hover:text-foreground underline underline-offset-4"
                  >
                    board
                  </Link>
                  .
                </p>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
            >
              Change
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}

function RepositoryForm({
  current,
  onDone,
  onCancel,
}: {
  current: Repository | null
  onDone: () => void
  onCancel?: () => void
}) {
  const qc = useQueryClient()
  const org = useOrg()
  const computer = useQuery({
    queryKey: computerQueryKey,
    queryFn: getComputer,
  })
  const installations = computer.data?.github.installations ?? []
  const [installationId, setInstallationId] = useState(
    current ? String(current.installationId) : '',
  )
  const [name, setName] = useState(current?.name ?? '')
  const [branch, setBranch] = useState(current?.branch ?? 'main')
  const installation =
    installations.find((i) => i.id === installationId) ??
    (installations.length === 1 ? installations[0] : undefined)

  const save = useMutation({
    mutationFn: () =>
      putRepository({
        installationId: installation!.id,
        owner: installation!.accountLogin,
        name: name.trim(),
        branch: branch.trim() || 'main',
      }),
    onSuccess: (repository) => {
      qc.setQueryData(workKeys.repository(org), repository)
      void qc.invalidateQueries({ queryKey: ['work', org] })
      notifySuccess('Working docs repository saved.')
      onDone()
    },
    onError: (e) => notifyError('Could not save the repository', e),
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (installation && name.trim()) save.mutate()
  }

  if (computer.isSuccess && installations.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground">
          Connect GitHub first: working docs live in one of its repositories.
        </p>
        <Button size="sm" variant="outline" asChild>
          <Link to="/managed-agents/connections">Connect GitHub</Link>
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-3 py-1">
      <p className="text-muted-foreground">
        Pick the repository where agents keep working docs for tracked items.
        Everyone in the organization can read them.
      </p>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,20rem)_minmax(0,8rem)]">
        <Field label="GitHub account" htmlFor="work-repo-account">
          <Select
            id="work-repo-account"
            value={installation?.id ?? ''}
            onValueChange={setInstallationId}
            placeholder="Choose"
            options={installations.map((i) => ({
              value: i.id,
              label: i.accountLogin,
            }))}
          />
        </Field>
        <Field label="Repository" htmlFor="work-repo-name">
          <Input
            id="work-repo-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="knowledge"
            autoComplete="off"
          />
        </Field>
        <Field label="Branch" htmlFor="work-repo-branch">
          <Input
            id="work-repo-branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            autoComplete="off"
          />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={!installation || !name.trim() || save.isPending}
        >
          {save.isPending ? <Loader2 className="animate-spin" /> : null}
          Save
        </Button>
        {onCancel ? (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  )
}
