import { type FormEvent, useContext, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate } from 'react-router-dom'
import { History, KeyRound, Loader2, Plus, TriangleAlert } from 'lucide-react'
import { ApiError } from '@/api/errors'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { Badge } from '@/components/ui/badge'
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
import { relativeTime } from './computer-state'
import {
  SECRET_NAME,
  deleteOrgSecret,
  getOrgSecrets,
  getSecretEvents,
  orgSecretsQueryKey,
  putOrgSecret,
  secretEventsQueryKey,
  type OrgSecret,
  type SecretActor,
  type SecretEvent,
} from './computer-secrets-api'

// The computer's organization secrets (serverless-agents-ws work 095, v1):
// the Organization view of the plan's mockup. Personal and thread secrets stay
// in Slack for now; a row only counts where one of those wins over it.

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
  const [historyOf, setHistoryOf] = useState<string | null>(null)

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
        description="Every session on your computer gets these as environment variables. Anyone in your organization can set them; values can't be read back."
        actions={secrets.data?.length ? add : null}
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
        ) : !secrets.data?.length ? (
          <EmptyState
            icon={KeyRound}
            title="No secrets yet"
            description="Add an API key or token once, and every session can use it."
            action={add}
          />
        ) : (
          <SecretsTable
            secrets={secrets.data}
            onReplace={(secret) => setEditing({ mode: 'replace', secret })}
            onDelete={setDeleting}
            onHistory={setHistoryOf}
          />
        )}
      </Panel>
      <p className="text-muted-foreground mt-3 text-xs">
        Sessions can read these values, so anyone who can talk to your computer
        can use them. Slack sessions get them today; API and dashboard sessions
        will soon.
      </p>

      {editing ? (
        <SecretDialog editing={editing} onClose={() => setEditing(null)} />
      ) : null}
      <DeleteSecretDialog secret={deleting} onClose={() => setDeleting(null)} />
      <HistoryDialog name={historyOf} onClose={() => setHistoryOf(null)} />
    </div>
  )
}

function SecretsTable({
  secrets,
  onReplace,
  onDelete,
  onHistory,
}: {
  secrets: OrgSecret[]
  onReplace: (secret: OrgSecret) => void
  onDelete: (secret: OrgSecret) => void
  onHistory: (name: string) => void
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Name</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead>Last used</TableHead>
          <TableHead className="pr-4 text-right">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {secrets.map((secret) => (
          <TableRow key={secret.name}>
            <TableCell className="py-3 pl-4 align-top">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-medium">
                  {secret.name}
                </span>
                {secret.kind === 'variable' ? (
                  <Badge variant="secondary">Variable</Badge>
                ) : null}
                {secret.file ? <Badge variant="secondary">File</Badge> : null}
              </div>
              {secret.kind === 'variable' && secret.value ? (
                <p className="text-muted-foreground mt-1 max-w-md truncate font-mono text-xs">
                  {secret.value}
                </p>
              ) : null}
              <Overridden in={secret.overriddenIn} />
            </TableCell>
            <TableCell className="py-3 align-top text-sm">
              {secret.updatedAt ? relativeTime(secret.updatedAt) : '—'}
              <p className="text-muted-foreground text-xs">
                {actorLabel(secret.updatedBy)}
              </p>
            </TableCell>
            <TableCell className="text-muted-foreground py-3 align-top text-sm">
              {secret.lastUsedAt ? relativeTime(secret.lastUsedAt) : 'Not yet'}
            </TableCell>
            <TableCell className="py-2 pr-4 text-right align-top">
              <div className="flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`History of ${secret.name}`}
                  onClick={() => onHistory(secret.name)}
                >
                  <History className="size-4" aria-hidden />
                </Button>
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
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/**
 * A thread's or a person's copy of the name, set in Slack, wins over this one
 * where it applies: the stale copy that silently beat the org value is the
 * bug that started work 095.
 */
function Overridden({ in: counts }: { in: OrgSecret['overriddenIn'] }) {
  const parts = [
    counts.threads
      ? `${counts.threads} ${counts.threads === 1 ? 'thread' : 'threads'}`
      : null,
    counts.people
      ? `for ${counts.people} ${counts.people === 1 ? 'person' : 'people'}`
      : null,
  ].filter(Boolean)
  if (!parts.length) return null
  const where = counts.threads
    ? `in ${parts.join(' and ')}`
    : (parts[0] as string)
  return (
    <p className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
      <TriangleAlert className="size-3 shrink-0" aria-hidden />
      Overridden {where} by a copy set in Slack
    </p>
  )
}

function actorLabel(actor: SecretActor | null): string {
  if (!actor) return ''
  if ('member' in actor) return actor.name ?? 'A member'
  if ('slackUserId' in actor) return 'From Slack'
  return 'OpenComputer'
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
  const [variable, setVariable] = useState(replacing?.kind === 'variable')
  const [file, setFile] = useState(replacing?.file ?? false)
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
    save.mutate({ name: trimmed, value, file: !variable && file, variable })
  }

  const what = variable ? 'variable' : 'secret'
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
            {file && !variable ? (
              <textarea
                id="secret-value"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                rows={6}
                autoComplete="off"
                spellCheck={false}
                className="border-input bg-background w-full rounded-md border px-2.5 py-2 font-mono text-xs outline-none"
              />
            ) : (
              <Input
                id="secret-value"
                type={variable ? 'text' : 'password'}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            )}
          </div>

          {replacing ? null : (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Kind</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="secret-kind"
                  checked={!variable}
                  onChange={() => setVariable(false)}
                  className="mt-1"
                />
                <span>
                  Secret
                  <span className="text-muted-foreground block text-xs">
                    Write-only, and hidden from session output.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="secret-kind"
                  checked={variable}
                  onChange={() => setVariable(true)}
                  className="mt-1"
                />
                <span>
                  Variable
                  <span className="text-muted-foreground block text-xs">
                    Not sensitive, and shown here, like a region or a base URL.
                  </span>
                </span>
              </label>
            </fieldset>
          )}

          {variable || replacing ? null : (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={file}
                onChange={(event) => setFile(event.target.checked)}
                className="mt-1"
              />
              <span>
                Save as a file
                <span className="text-muted-foreground block text-xs">
                  For a key file or kubeconfig: the variable holds the
                  file&apos;s path.
                </span>
              </span>
            </label>
          )}

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
              {replacing ? 'Replace' : `Add ${what}`}
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
      description="Running sessions lose it right away. Copies set in Slack for a thread or a person stay."
      confirmLabel="Delete"
      destructive
      pending={remove.isPending}
      onConfirm={() => secret && remove.mutate(secret.name)}
    />
  )
}

const ACTIONS: Record<string, string> = {
  set: 'Set',
  replace: 'Replaced',
  delete: 'Deleted',
  expire: 'Expired',
}

const SURFACES: Record<string, string> = {
  slack: 'in Slack',
  dashboard: 'in the dashboard',
  api: 'with an API key',
  opc: 'from the CLI',
}

function HistoryDialog({
  name,
  onClose,
}: {
  name: string | null
  onClose: () => void
}) {
  const events = useQuery({
    queryKey: secretEventsQueryKey(name ?? ''),
    queryFn: () => getSecretEvents(name!),
    enabled: name !== null,
  })
  return (
    <Dialog open={name !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono">{name}</DialogTitle>
          <DialogDescription>
            Who changed it, and where. Values are never recorded.
          </DialogDescription>
        </DialogHeader>
        {events.isLoading ? (
          <div className="flex min-h-24 items-center justify-center">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : events.isError ? (
          <p className="text-muted-foreground text-sm">
            Couldn&apos;t load the history. {events.error.message}
          </p>
        ) : !events.data?.length ? (
          <p className="text-muted-foreground text-sm">
            No changes recorded yet. History starts with this release.
          </p>
        ) : (
          <ol className="max-h-[24rem] divide-y overflow-y-auto rounded-md border">
            {events.data.map((event, index) => (
              <HistoryRow key={`${event.at}-${index}`} event={event} />
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  )
}

function HistoryRow({ event }: { event: SecretEvent }) {
  const who = actorLabel(event.actor)
  return (
    <li className="flex items-baseline justify-between gap-4 px-3 py-2 text-sm">
      <span>
        {ACTIONS[event.action] ?? event.action}
        {who && event.actor && !('slackUserId' in event.actor)
          ? ` by ${who}`
          : ''}{' '}
        <span className="text-muted-foreground">
          {SURFACES[event.via] ?? ''}
        </span>
      </span>
      <span className="text-muted-foreground shrink-0 text-xs">
        {event.at ? relativeTime(event.at) : ''}
      </span>
    </li>
  )
}
