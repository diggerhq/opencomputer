import { type FormEvent, useContext, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate } from 'react-router-dom'
import { KeyRound, Loader2, Plus } from 'lucide-react'
import { ApiError } from '@/api/errors'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { AuthContext } from '@/hooks/useAuth'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  SECRET_NAME,
  deleteOrgSecret,
  getOrgSecretEvents,
  getOrgSecrets,
  orgSecretEventsQueryKey,
  orgSecretsQueryKey,
  putOrgSecret,
  type OrgSecret,
  type OrgSecretEvent,
} from './computer-secrets-api'

// The computer's organization secrets (serverless-agents-ws work 095, v1):
// names only. Any member adds one; its creator or an organization admin
// replaces or deletes it (the server's `canChange`); everyone sees the names and
// the recent changes. Personal and thread secrets stay in Slack for now.

export default function ComputerSecretsPage() {
  const auth = useContext(AuthContext)
  if (auth?.user && !auth.user.computerEnabled)
    return <Navigate to="/" replace />
  return <ComputerSecrets />
}

type Editing = { mode: 'add' } | { mode: 'replace'; secret: OrgSecret }

export function ComputerSecrets() {
  const secrets = useQuery({
    queryKey: orgSecretsQueryKey,
    queryFn: getOrgSecrets,
  })
  const [editing, setEditing] = useState<Editing | null>(null)
  const [deleting, setDeleting] = useState<OrgSecret | null>(null)
  const list = secrets.data?.secrets

  const add = (
    <Button onClick={() => setEditing({ mode: 'add' })}>
      <Plus className="size-4" aria-hidden />
      Add secret
    </Button>
  )

  return (
    <div>
      <PageHeader
        title="Secrets"
        description="Every session on your computer gets these as environment variables. Anyone in the organization can add one; only whoever added it or an admin can replace or delete it. Values can't be read back."
        actions={list?.length ? add : null}
      />
      <Panel>
        {secrets.isLoading ? (
          <div
            role="status"
            aria-label="Loading"
            className="flex min-h-40 items-center justify-center"
          >
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : secrets.isError ? (
          <EmptyState
            icon={KeyRound}
            title="Secrets are temporarily unavailable"
            description={secrets.error.message}
            action={
              <Button variant="outline" onClick={() => void secrets.refetch()}>
                Try again
              </Button>
            }
          />
        ) : !list?.length ? (
          <EmptyState
            icon={KeyRound}
            title="No secrets yet"
            description="Add an API key or token once, and every session can use it."
            action={add}
          />
        ) : (
          <SecretsTable
            secrets={list}
            onReplace={(secret) => setEditing({ mode: 'replace', secret })}
            onDelete={setDeleting}
          />
        )}
      </Panel>
      <p className="text-muted-foreground mt-3 text-xs">
        These are organization-wide. A Slack thread or a person can set their
        own value for the same name in Slack, and theirs is used there instead.
      </p>
      {secrets.isSuccess ? <RecentChanges /> : null}

      {editing ? (
        <SecretDialog editing={editing} onClose={() => setEditing(null)} />
      ) : null}
      <DeleteSecretDialog secret={deleting} onClose={() => setDeleting(null)} />
    </div>
  )
}

function SecretsTable({
  secrets,
  onReplace,
  onDelete,
}: {
  secrets: OrgSecret[]
  /** Offered on the rows the viewer may change (`canChange`). */
  onReplace: (secret: OrgSecret) => void
  onDelete: (secret: OrgSecret) => void
}) {
  const actions = secrets.some((s) => s.canChange)
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Name</TableHead>
          {actions ? (
            <TableHead className="pr-4 text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {secrets.map((secret) => (
          <TableRow key={secret.name}>
            <TableCell className="py-3 pl-4 font-mono text-sm font-medium">
              {secret.name}
            </TableCell>
            {actions ? (
              <TableCell className="py-2 pr-4 text-right">
                {secret.canChange ? (
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onReplace(secret)}
                    >
                      Replace
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => onDelete(secret)}
                    >
                      Delete
                    </Button>
                  </div>
                ) : null}
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function SecretDialog({
  editing,
  onClose,
}: {
  editing: Editing
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const replacing = editing.mode === 'replace' ? editing.secret : null
  const [name, setName] = useState(replacing?.name ?? '')
  const [value, setValue] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: putOrgSecret,
    onSuccess: async (secret) => {
      await queryClient.invalidateQueries({ queryKey: orgSecretsQueryKey })
      notifySuccess(
        `${secret.name} ${replacing ? 'replaced' : 'saved'}.`,
        'Running sessions get it right away.',
      )
      onClose()
    },
    onError: (error) => {
      if (error instanceof ApiError && error.type === 'invalid_name') {
        setNameError(error.message)
        return
      }
      notifyError("Couldn't save it.", error)
    },
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (!SECRET_NAME.test(trimmed)) {
      setNameError(
        'Use letters, digits and _, not starting with a digit (at most 64).',
      )
      return
    }
    if (!value) return
    save.mutate({ name: trimmed, value, file: false, variable: false })
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>
              {replacing ? `Replace ${replacing.name}` : 'Add a secret'}
            </DialogTitle>
            <DialogDescription>
              {replacing
                ? `The new value replaces the old one for every session. The old value can't be shown.`
                : 'Every session on your computer gets it as an environment variable.'}
            </DialogDescription>
          </DialogHeader>

          {replacing ? null : (
            <div className="space-y-2">
              <Label htmlFor="secret-name">Name</Label>
              <Input
                id="secret-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value.toUpperCase())
                  setNameError(null)
                }}
                placeholder="EXECUTOR_API_KEY"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? 'secret-name-error' : undefined}
              />
              {nameError ? (
                <p id="secret-name-error" className="text-destructive text-xs">
                  {nameError}
                </p>
              ) : null}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="secret-value">Value</Label>
            <Input
              id="secret-value"
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={save.isPending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!value || save.isPending}>
              {save.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              {replacing ? 'Replace' : 'Add secret'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteSecretDialog({
  secret,
  onClose,
}: {
  secret: OrgSecret | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: deleteOrgSecret,
    onSuccess: async (_, name) => {
      await queryClient.invalidateQueries({ queryKey: orgSecretsQueryKey })
      notifySuccess(`${name} deleted.`)
      onClose()
    },
    onError: (error) => notifyError("Couldn't delete it.", error),
  })
  return (
    <ConfirmDialog
      open={secret !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`Delete ${secret?.name ?? ''} for the organization?`}
      description="Running sessions lose it right away."
      confirmLabel="Delete"
      destructive
      pending={remove.isPending}
      onConfirm={() => secret && remove.mutate(secret.name)}
    />
  )
}

const ACTION: Record<OrgSecretEvent['action'], string> = {
  set: 'added',
  replace: 'replaced',
  delete: 'deleted',
}

function actorLabel(event: OrgSecretEvent): string {
  const actor = event.actor
  if (!actor) return 'someone'
  if ('member' in actor) return actor.name ?? 'a member'
  if ('slackUserId' in actor) return 'someone in Slack'
  return 'the system'
}

/**
 * The organization's notice of changes: every add, replace and delete, by
 * whom, from where and when; never a value. Members see it too.
 */
function RecentChanges() {
  const events = useQuery({
    queryKey: orgSecretEventsQueryKey,
    queryFn: getOrgSecretEvents,
  })
  if (!events.data?.length) return null
  return (
    <section className="mt-8" aria-labelledby="secret-changes">
      <h2 id="secret-changes" className="mb-2 text-sm font-medium">
        Recent changes
      </h2>
      <Panel>
        <ul className="divide-y text-sm">
          {events.data.slice(0, 20).map((event, i) => (
            <li
              key={`${event.at}-${event.name}-${i}`}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2"
            >
              <span>
                <span className="font-mono font-medium">{event.name}</span>{' '}
                {ACTION[event.action]} by {actorLabel(event)}
                <span className="text-muted-foreground"> via {event.via}</span>
              </span>
              {event.at ? (
                <time
                  dateTime={event.at}
                  className="text-muted-foreground text-xs"
                >
                  {new Date(event.at).toLocaleString()}
                </time>
              ) : null}
            </li>
          ))}
        </ul>
      </Panel>
    </section>
  )
}
