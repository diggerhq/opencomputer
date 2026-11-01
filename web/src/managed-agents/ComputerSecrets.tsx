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
  getOrgSecrets,
  orgSecretsQueryKey,
  putOrgSecret,
  type OrgSecret,
} from './computer-secrets-api'

// The computer's organization secrets (serverless-agents-ws work 095, v1):
// names only, set and replaced from here. Personal and thread secrets stay in
// Slack for now.

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
          />
        )}
      </Panel>

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
  onReplace: (secret: OrgSecret) => void
  onDelete: (secret: OrgSecret) => void
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Name</TableHead>
          <TableHead className="pr-4 text-right">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {secrets.map((secret) => (
          <TableRow key={secret.name}>
            <TableCell className="py-3 pl-4 font-mono text-sm font-medium">
              {secret.name}
            </TableCell>
            <TableCell className="py-2 pr-4 text-right">
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
            </TableCell>
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
