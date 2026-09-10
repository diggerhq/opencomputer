import { useState } from 'react'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { BookOpen, Download, Loader2, Plus } from 'lucide-react'
import { ApiError } from '@/api/client'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { Field, Select, Textarea } from '@/components/form'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelFooter,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { ResourceTable, type Column } from '@/components/resource-table'
import { StatusBadge } from '@/components/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { Switch } from '@/components/ui/switch'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  createManagedMemoryDocument,
  deleteManagedMemoryDocument,
  getManagedAgentDeployment,
  getManagedMemoryDocument,
  getManagedMemoryDocuments,
  getManagedMemoryResources,
  patchManagedMemoryDocument,
  replaceManagedMemoryDocument,
  type ManagedMemoryDocument,
  type ManagedMemoryDocumentMeta,
  type ManagedMemoryDocumentRead,
  type ManagedMemoryDocumentTarget,
  type ManagedMemoryEnvironment,
} from './api'
import {
  formatMemoryBytes,
  isOverMemoryLimit,
  listMemoryResources,
  memoryExportFile,
  memoryResourceHint,
  memoryWriterLabel,
  type MemoryResourceSummary,
} from './memory-documents'

function formatDate(value: string) {
  return new Date(value).toLocaleString()
}

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/

function WriterCell({
  projectId,
  document,
}: {
  projectId: string
  document: ManagedMemoryDocumentMeta
}) {
  if (document.writer.kind === 'agent') {
    return (
      <Link
        className="text-xs underline-offset-4 hover:underline"
        to={`/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(document.writer.sessionId)}`}
      >
        {memoryWriterLabel(document.writer)}
      </Link>
    )
  }
  return <span className="text-xs">{memoryWriterLabel(document.writer)}</span>
}

// The editor carries the complete target it read (resource, document id,
// revision) from the read through editing, saving and conflict handling; a
// save addresses that target, never whatever the selector shows by then. A
// save that loses the race shows the current document instead of
// overwriting it (document-memory.mdx, "Conflicts").
type EditorState = {
  target: ManagedMemoryDocumentTarget
  meta: ManagedMemoryDocumentMeta
  base: ManagedMemoryDocumentRead
  text: string
  summary: string
  conflict?: ManagedMemoryDocumentRead
}

export function ManagedProjectMemory({
  projectId,
  environment,
  deploymentIds,
}: {
  projectId: string
  environment: ManagedMemoryEnvironment
  /** Active deployments of every project member in this environment; their declarations name the resources when the backend has no inventory. */
  deploymentIds: string[]
}) {
  const inventory = useQuery({
    queryKey: [
      'managed-memory-resources',
      projectId,
      environment,
      deploymentIds,
    ],
    queryFn: () =>
      listMemoryResources({
        inventory: () => getManagedMemoryResources({ projectId, environment }),
        declarations: () =>
          Promise.all(deploymentIds.map(getManagedAgentDeployment)),
      }),
  })
  const known = inventory.data?.resources ?? []
  const [selectedResource, setSelectedResource] = useState<string>()
  const [customResource, setCustomResource] = useState('')
  const resource = selectedResource ?? known[0]?.id
  const summary = known.find((candidate) => candidate.id === resource)

  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>Memory</PanelTitle>
          <PanelDescription>
            Documents saved in {environment}, per resource. Owner edits use the
            same revision checks as agent saves.
          </PanelDescription>
        </div>
      </PanelHeader>
      <PanelContent className="grid gap-4 md:grid-cols-[minmax(0,20rem)_1fr] md:items-end">
        <Field
          label="Resource"
          htmlFor="memory-resource"
          description={
            summary && !summary.declared
              ? 'No active deployment declares this resource; its documents are kept until you delete them.'
              : inventory.data?.source === 'declarations'
                ? 'Listed from active deployments; undeclared resources are not shown here. Open one by ID.'
                : known.length || inventory.isLoading
                  ? undefined
                  : 'No memory resources here yet; open one by ID.'
          }
        >
          {known.length || resource ? (
            <Select
              id="memory-resource"
              value={resource ?? ''}
              onValueChange={setSelectedResource}
              options={[
                ...known.map((candidate) => ({
                  value: candidate.id,
                  label: candidate.id,
                  ...(memoryResourceHint(candidate)
                    ? { hint: memoryResourceHint(candidate) }
                    : {}),
                })),
                // A resource opened by ID that the inventory does not list.
                ...(resource && !summary
                  ? [{ value: resource, label: resource, hint: 'not listed' }]
                  : []),
              ]}
              placeholder="Choose a resource"
            />
          ) : (
            <Input
              id="memory-resource"
              value=""
              readOnly
              placeholder={
                inventory.isLoading
                  ? 'Loading resources'
                  : 'No resource selected'
              }
            />
          )}
        </Field>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const next = customResource.trim()
            if (!next) return
            setSelectedResource(next)
            setCustomResource('')
          }}
        >
          <Input
            aria-label="Other resource ID"
            value={customResource}
            placeholder="Other resource ID"
            onChange={(event) => setCustomResource(event.target.value)}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={!customResource.trim()}
          >
            Open
          </Button>
        </form>
      </PanelContent>
      {inventory.isError ? (
        <PanelContent className="border-t">
          <EmptyState
            icon={BookOpen}
            title="Couldn't list memory resources"
            description={
              inventory.error instanceof Error
                ? inventory.error.message
                : 'Try loading this page again.'
            }
          />
        </PanelContent>
      ) : resource ? (
        // Keyed by the selection: switching resources remounts the documents
        // panel, so drafts, dialogs and in-flight reads belong to the resource
        // they were started for, and a read that resolves after the switch
        // has nowhere to land.
        <MemoryResourceDocuments
          key={`${environment}:${resource}`}
          projectId={projectId}
          environment={environment}
          resource={resource}
          summary={summary}
        />
      ) : (
        <PanelContent className="border-t">
          <EmptyState
            icon={BookOpen}
            title="Choose a resource"
            description="Resources come from the deployments that declare them and from the documents already saved here."
          />
        </PanelContent>
      )}
    </Panel>
  )
}

function MemoryResourceDocuments({
  projectId,
  environment,
  resource,
  summary,
}: {
  projectId: string
  environment: ManagedMemoryEnvironment
  resource: string
  summary?: MemoryResourceSummary
}) {
  const queryClient = useQueryClient()
  const target = (id: string): ManagedMemoryDocumentTarget => ({
    projectId,
    resource,
    id,
    environment,
  })
  const listKey = ['managed-memory-documents', projectId, environment, resource]

  const documents = useInfiniteQuery({
    queryKey: listKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      getManagedMemoryDocuments({
        projectId,
        resource,
        environment,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })
  const rows = documents.data?.pages.flatMap((page) => page.documents) ?? []

  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({
    id: '',
    title: '',
    summary: '',
    text: '',
    agentWrites: true,
  })
  const [editor, setEditor] = useState<EditorState>()
  const [removing, setRemoving] = useState<ManagedMemoryDocumentMeta>()

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: listKey }),
      queryClient.invalidateQueries({
        queryKey: ['managed-memory-resources', projectId, environment],
      }),
    ])

  const create = useMutation({
    mutationFn: () =>
      createManagedMemoryDocument({
        ...target(draft.id.trim()),
        title: draft.title.trim(),
        text: draft.text,
        ...(draft.summary.trim() ? { summary: draft.summary.trim() } : {}),
        ...(draft.agentWrites ? {} : { agentWrites: 'disabled' as const }),
      }),
    onSuccess: async ({ document }) => {
      setCreating(false)
      setDraft({ id: '', title: '', summary: '', text: '', agentWrites: true })
      notifySuccess(`Created ${document.id}.`)
      await invalidate()
    },
    onError: (error) => notifyError("Couldn't create that document.", error),
  })

  // The read's variables are the target; the editor opens on exactly that.
  const openEditor = useMutation({
    mutationFn: (input: {
      target: ManagedMemoryDocumentTarget
      meta: ManagedMemoryDocumentMeta
    }) => getManagedMemoryDocument(input.target),
    onSuccess: (base, input) =>
      setEditor({
        target: input.target,
        meta: input.meta,
        base,
        text: base.document.text,
        summary: base.document.summary,
      }),
    onError: (error) => notifyError("Couldn't open that document.", error),
  })

  const save = useMutation({
    mutationFn: async (state: EditorState) => {
      try {
        return await replaceManagedMemoryDocument({
          ...state.target,
          etag: state.base.etag,
          text: state.text,
          summary: state.summary,
        })
      } catch (error) {
        if (error instanceof ApiError && error.status === 412) {
          const conflict = await getManagedMemoryDocument(state.target)
          setEditor({ ...state, conflict })
          return undefined
        }
        throw error
      }
    },
    onSuccess: async (saved) => {
      if (!saved) return
      setEditor(undefined)
      notifySuccess(
        `Saved ${saved.document.id}.`,
        `Revision ${saved.document.revision}.`,
      )
      await invalidate()
    },
    onError: (error) => notifyError("Couldn't save that document.", error),
  })

  // Freeze and unfreeze read the document first so the precondition carries
  // the ETag verbatim rather than a revision reassembled from the list.
  const setAgentWrites = useMutation({
    mutationFn: async (input: {
      meta: ManagedMemoryDocumentMeta
      agentWrites: 'enabled' | 'disabled'
    }) => {
      const current = await getManagedMemoryDocument(target(input.meta.id))
      return patchManagedMemoryDocument({
        ...target(input.meta.id),
        etag: current.etag,
        agentWrites: input.agentWrites,
      })
    },
    onSuccess: async ({ document }) => {
      notifySuccess(
        document.agentWrites === 'disabled'
          ? `Agent writes disabled for ${document.id}.`
          : `Agent writes enabled for ${document.id}.`,
      )
      await invalidate()
    },
    onError: (error) =>
      notifyError("Couldn't change that document's policy.", error),
  })

  const remove = useMutation({
    mutationFn: async (meta: ManagedMemoryDocumentMeta) => {
      const current = await getManagedMemoryDocument(target(meta.id))
      await deleteManagedMemoryDocument({
        ...target(meta.id),
        etag: current.etag,
      })
    },
    onSuccess: async (_, meta) => {
      setRemoving(undefined)
      notifySuccess(`Deleted ${meta.id}.`, 'Its ID stays reserved.')
      await invalidate()
    },
    onError: (error) => notifyError("Couldn't delete that document.", error),
  })

  const exportResource = useMutation({
    mutationFn: async () => {
      const all: ManagedMemoryDocument[] = []
      let cursor: string | undefined
      do {
        const page = await getManagedMemoryDocuments({
          projectId,
          resource,
          environment,
          ...(cursor ? { cursor } : {}),
        })
        for (const meta of page.documents) {
          all.push((await getManagedMemoryDocument(target(meta.id))).document)
        }
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      const file = memoryExportFile({
        resource,
        environment,
        documents: all,
        exportedAt: new Date(),
      })
      const url = URL.createObjectURL(
        new Blob([file.body], { type: 'application/json' }),
      )
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = file.name
      anchor.click()
      URL.revokeObjectURL(url)
      return all.length
    },
    onSuccess: (count) =>
      notifySuccess(`Exported ${count} document${count === 1 ? '' : 's'}.`),
    onError: (error) => notifyError("Couldn't export that resource.", error),
  })

  const columns: Column<ManagedMemoryDocumentMeta>[] = [
    {
      key: 'document',
      header: 'Document',
      cell: (document) => (
        <div className="min-w-0">
          <p className="text-sm font-medium">{document.title}</p>
          <p className="text-muted-foreground mt-0.5 font-mono text-xs">
            {document.id}
          </p>
          {document.summary ? (
            <p className="text-muted-foreground mt-1 max-w-xl truncate text-xs">
              {document.summary}
            </p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'size',
      header: 'Size',
      cell: (document) => (
        <div className="flex items-center gap-2">
          <span className="text-xs tabular-nums">
            {formatMemoryBytes(document.bytes)} /{' '}
            {formatMemoryBytes(document.maxBytes)}
          </span>
          {isOverMemoryLimit(document) ? (
            <Badge variant="destructive">Over limit</Badge>
          ) : null}
        </div>
      ),
    },
    {
      key: 'agent-writes',
      header: 'Agent writes',
      cell: (document) => (
        <StatusBadge
          status={document.agentWrites === 'enabled' ? 'active' : 'paused'}
          label={document.agentWrites === 'enabled' ? 'Enabled' : 'Frozen'}
        />
      ),
    },
    {
      key: 'writer',
      header: 'Last writer',
      cell: (document) => (
        <WriterCell projectId={projectId} document={document} />
      ),
    },
    {
      key: 'updated',
      header: 'Updated',
      cell: (document) => (
        <span className="text-muted-foreground text-xs">
          {formatDate(document.updatedAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (document) => (
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={openEditor.isPending}
            onClick={() =>
              openEditor.mutate({ target: target(document.id), meta: document })
            }
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={setAgentWrites.isPending}
            onClick={() =>
              setAgentWrites.mutate({
                meta: document,
                agentWrites:
                  document.agentWrites === 'enabled' ? 'disabled' : 'enabled',
              })
            }
          >
            {document.agentWrites === 'enabled' ? 'Freeze' : 'Unfreeze'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRemoving(document)}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ]

  const draftIdValid = DOCUMENT_ID.test(draft.id.trim())
  const conflictWriter = editor?.conflict
    ? memoryWriterLabel(editor.conflict.document.writer)
    : undefined
  const maxBytes = summary?.provider.maxBytes

  return (
    <>
      <PanelContent className="flex flex-wrap items-center justify-between gap-3 border-t">
        <div className="min-w-0">
          <p className="text-sm font-medium">{resource}</p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {summary
              ? [
                  summary.declared ? undefined : 'Not declared',
                  maxBytes !== undefined
                    ? `${formatMemoryBytes(maxBytes)} per document`
                    : undefined,
                  summary.documents !== undefined
                    ? `${summary.documents} ${summary.documents === 1 ? 'document' : 'documents'}`
                    : undefined,
                ]
                  .filter((part) => part !== undefined)
                  .join(' · ')
              : 'Opened by ID.'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={exportResource.isPending}
            onClick={() => exportResource.mutate()}
          >
            {exportResource.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Download />
            )}
            Export
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> Create document
          </Button>
        </div>
      </PanelContent>
      {documents.isError ? (
        <PanelContent className="border-t">
          <EmptyState
            icon={BookOpen}
            title={`Couldn't load ${resource}`}
            description={
              documents.error instanceof Error
                ? documents.error.message
                : 'Try loading this resource again.'
            }
          />
        </PanelContent>
      ) : (
        <PanelContent className="border-t p-0">
          <ResourceTable
            columns={columns}
            rows={rows}
            rowKey={(document) => document.id}
            loading={documents.isLoading}
            empty={
              <EmptyState
                icon={BookOpen}
                title={`No ${environment} documents in ${resource}`}
                description="Create one here or with `opencomputer memory create`. A session can only bind to a document that exists."
              />
            }
          />
        </PanelContent>
      )}
      {documents.hasNextPage ? (
        <PanelFooter>
          <Button
            size="sm"
            variant="outline"
            disabled={documents.isFetchingNextPage}
            onClick={() => void documents.fetchNextPage()}
          >
            {documents.isFetchingNextPage ? (
              <Loader2 className="animate-spin" />
            ) : null}
            Load more
          </Button>
        </PanelFooter>
      ) : null}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create document</DialogTitle>
            <DialogDescription>
              A new document in {resource} ({environment}). A deleted ID cannot
              be reused, so choose IDs deliberately.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Document ID"
              htmlFor="memory-create-id"
              required
              error={
                draft.id && !draftIdValid
                  ? 'Letters, digits, - and _ only; up to 128 characters.'
                  : undefined
              }
            >
              <Input
                id="memory-create-id"
                value={draft.id}
                maxLength={128}
                placeholder="workshop"
                onChange={(event) =>
                  setDraft({ ...draft, id: event.target.value })
                }
              />
            </Field>
            <Field label="Title" htmlFor="memory-create-title" required>
              <Input
                id="memory-create-title"
                value={draft.title}
                maxLength={240}
                placeholder="Workshop requirements"
                onChange={(event) =>
                  setDraft({ ...draft, title: event.target.value })
                }
              />
            </Field>
          </div>
          <Field
            label="Summary"
            htmlFor="memory-create-summary"
            description="Shown in collection overviews. Up to 240 bytes."
          >
            <Input
              id="memory-create-summary"
              value={draft.summary}
              maxLength={240}
              onChange={(event) =>
                setDraft({ ...draft, summary: event.target.value })
              }
            />
          </Field>
          <Field
            label="Text"
            htmlFor="memory-create-text"
            description={
              maxBytes !== undefined
                ? `Up to ${formatMemoryBytes(maxBytes)} of UTF-8.`
                : undefined
            }
          >
            <Textarea
              id="memory-create-text"
              className="min-h-40 font-mono text-xs"
              value={draft.text}
              onChange={(event) =>
                setDraft({ ...draft, text: event.target.value })
              }
            />
          </Field>
          <div className="flex items-center gap-3">
            <Switch
              id="memory-create-agent-writes"
              checked={draft.agentWrites}
              onCheckedChange={(checked) =>
                setDraft({ ...draft, agentWrites: checked })
              }
            />
            <Label htmlFor="memory-create-agent-writes">
              Allow agent writes
            </Label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                !draftIdValid || !draft.title.trim() || create.isPending
              }
              onClick={() => create.mutate()}
            >
              {create.isPending ? <Loader2 className="animate-spin" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(editor)}
        onOpenChange={(open) =>
          !open && !save.isPending && setEditor(undefined)
        }
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Edit {editor?.meta.title}</DialogTitle>
            <DialogDescription>
              Replaces the text and summary of {editor?.meta.id} at revision{' '}
              <span className="font-mono">
                {editor?.base.document.revision}
              </span>
              . The title and write policy are separate actions.
            </DialogDescription>
          </DialogHeader>
          {editor?.conflict ? (
            <Alert variant="destructive">
              <AlertTitle>
                This document changed while you were editing
              </AlertTitle>
              <AlertDescription>
                <p>
                  {conflictWriter} saved revision{' '}
                  <span className="font-mono">
                    {editor.conflict.document.revision}
                  </span>{' '}
                  at {formatDate(editor.conflict.document.updatedAt)}. Your
                  draft was not saved. The current text is shown below;
                  reconcile it into your draft, or discard your draft and start
                  from the current version.
                </p>
                <Textarea
                  aria-label="Current text"
                  readOnly
                  className="mt-2 min-h-32 font-mono text-xs"
                  value={editor.conflict.document.text}
                />
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      editor.conflict &&
                      setEditor({
                        ...editor,
                        base: editor.conflict,
                        conflict: undefined,
                      })
                    }
                  >
                    Keep my draft on the current revision
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      editor.conflict &&
                      setEditor({
                        ...editor,
                        base: editor.conflict,
                        text: editor.conflict.document.text,
                        summary: editor.conflict.document.summary,
                        conflict: undefined,
                      })
                    }
                  >
                    Discard my draft
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}
          {editor ? (
            <>
              <Field label="Summary" htmlFor="memory-edit-summary">
                <Input
                  id="memory-edit-summary"
                  value={editor.summary}
                  maxLength={240}
                  onChange={(event) =>
                    setEditor({ ...editor, summary: event.target.value })
                  }
                />
              </Field>
              <Field
                label="Text"
                htmlFor="memory-edit-text"
                description={`${formatMemoryBytes(new TextEncoder().encode(editor.text).byteLength)} of ${formatMemoryBytes(editor.base.document.maxBytes)}.`}
              >
                <Textarea
                  id="memory-edit-text"
                  className="min-h-64 font-mono text-xs"
                  value={editor.text}
                  onChange={(event) =>
                    setEditor({ ...editor, text: event.target.value })
                  }
                />
              </Field>
            </>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={save.isPending}
              onClick={() => setEditor(undefined)}
            >
              Cancel
            </Button>
            <Button
              disabled={!editor || Boolean(editor.conflict) || save.isPending}
              onClick={() => editor && save.mutate(editor)}
            >
              {save.isPending ? <Loader2 className="animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title={`Delete ${removing?.id}?`}
        description="Removes the saved text and summary. The ID stays reserved and cannot be recreated; sessions bound to this document fail their next recall."
        confirmLabel="Delete document"
        destructive
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </>
  )
}
