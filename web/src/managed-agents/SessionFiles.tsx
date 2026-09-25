import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  ChevronRight,
  Download,
  FileCheck2,
  FolderDown,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import {
  Panel,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  downloadManagedAgentWorkspaceArchive,
  downloadManagedAgentWorkspaceArtifact,
  exportManagedAgentWorkspaceFile,
  getManagedAgentWorkspaceArtifacts,
  getManagedAgentWorkspaceFiles,
  type ManagedWorkspaceArtifact,
  type ManagedWorkspaceFile,
} from './api'
import { DownloadCancelled } from './workspace-download'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

function fileName(path: string) {
  return path.split('/').pop() ?? path
}

function reportDownloadError(error: unknown) {
  if (error instanceof DownloadCancelled) return
  notifyError("Couldn't download that file.", error)
}

/**
 * Workspace listing, retained manifests and the verified download actions
 * shared by the session Files tab and the playground debug inspector.
 */
function useWorkspaceFiles(sessionId: string, live: boolean) {
  const queryClient = useQueryClient()
  const artifactsKey = ['managed-agent-session-artifacts', sessionId]
  const filesKey = ['managed-agent-session-workspace-files', sessionId]
  const files = useQuery({
    queryKey: filesKey,
    queryFn: () => getManagedAgentWorkspaceFiles(sessionId),
    refetchInterval: live ? 5_000 : false,
  })
  const artifacts = useQuery({
    queryKey: artifactsKey,
    queryFn: () => getManagedAgentWorkspaceArtifacts(sessionId),
  })

  const exportFile = useMutation({
    mutationFn: (path: string) =>
      exportManagedAgentWorkspaceFile(sessionId, path),
    onSuccess: (artifact) => {
      void queryClient.invalidateQueries({ queryKey: artifactsKey })
      notifySuccess(
        `Retained ${artifact.path} (${formatBytes(artifact.size)}).`,
      )
    },
    onError: (error) => notifyError("Couldn't export that file.", error),
  })

  const download = useMutation({
    mutationFn: (artifact: ManagedWorkspaceArtifact) =>
      downloadManagedAgentWorkspaceArtifact(
        fileName(artifact.path),
        artifact.size,
        () => Promise.resolve(artifact),
      ),
    onError: reportDownloadError,
  })

  const exportThenDownload = useMutation({
    mutationFn: (file: ManagedWorkspaceFile) =>
      downloadManagedAgentWorkspaceArtifact(
        fileName(file.path),
        file.size,
        async () => {
          const artifact = await exportManagedAgentWorkspaceFile(
            sessionId,
            file.path,
          )
          void queryClient.invalidateQueries({ queryKey: artifactsKey })
          return artifact
        },
      ),
    onError: reportDownloadError,
  })

  // An artifact only stands in for the current file when it was exported
  // from the very same S3 revision; a rewritten file needs a fresh export.
  const retainedFor = (file: ManagedWorkspaceFile) =>
    file.etag
      ? (artifacts.data ?? []).find(
          (artifact) =>
            artifact.path === file.path &&
            artifact.receipt.sourceEtag === file.etag,
        )
      : undefined

  const [archiveProgress, setArchiveProgress] = useState<string | null>(null)
  const downloadAll = useMutation({
    mutationFn: (workspace: ManagedWorkspaceFile[]) =>
      downloadManagedAgentWorkspaceArchive(
        `${sessionId}-workspace.zip`,
        workspace,
        async () => {
          const retained: ManagedWorkspaceArtifact[] = []
          for (const [index, file] of workspace.entries()) {
            setArchiveProgress(`Retaining ${index + 1}/${workspace.length}`)
            retained.push(
              retainedFor(file) ??
                (await exportManagedAgentWorkspaceFile(sessionId, file.path)),
            )
          }
          void queryClient.invalidateQueries({ queryKey: artifactsKey })
          return retained
        },
        (done, total) => setArchiveProgress(`Verifying ${done}/${total}`),
      ),
    onSuccess: (retained) =>
      notifySuccess(`Downloaded ${retained.length} verified files.`),
    onError: reportDownloadError,
    onSettled: () => setArchiveProgress(null),
  })

  const busy =
    exportFile.isPending ||
    download.isPending ||
    exportThenDownload.isPending ||
    downloadAll.isPending
  const busyPath =
    exportFile.variables ??
    exportThenDownload.variables?.path ??
    download.variables?.path

  return {
    files,
    artifacts,
    retainedFor,
    exportFile,
    download,
    exportThenDownload,
    downloadAll,
    archiveProgress,
    busy,
    busyPath,
  }
}

/**
 * Files the agent wrote under /workspace and the ones the provider has
 * retained. "Export" asks the provider to copy and hash a file; "Download"
 * fetches the retained bytes and verifies them against the manifest.
 */
export function SessionFiles({
  sessionId,
  live,
}: {
  sessionId: string
  /** The agent may still be writing; keep the listing fresh. */
  live: boolean
}) {
  const {
    files,
    artifacts,
    retainedFor,
    exportFile,
    download,
    exportThenDownload,
    downloadAll,
    archiveProgress,
    busy,
    busyPath,
  } = useWorkspaceFiles(sessionId, live)

  return (
    <div className="space-y-5">
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Workspace</PanelTitle>
            <PanelDescription className="mt-1">
              Files under <code>/workspace</code> as last synced from the
              sandbox. Downloading retains a verified copy first.
            </PanelDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !files.data?.length}
              onClick={() => downloadAll.mutate(files.data ?? [])}
            >
              {downloadAll.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <FolderDown className="size-3.5" />
              )}
              {archiveProgress ?? 'Download all'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void files.refetch()}
              disabled={files.isFetching}
              aria-label="Refresh workspace files"
            >
              <RefreshCw
                className={
                  files.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'
                }
              />
            </Button>
          </div>
        </PanelHeader>
        {files.isLoading ? (
          <div className="flex min-h-24 items-center justify-center">
            <Loader2 className="text-muted-foreground size-4 animate-spin" />
          </div>
        ) : files.isError ? (
          <p className="text-status-error px-5 py-4 text-sm">
            Workspace listing is unavailable for this session.
          </p>
        ) : (files.data ?? []).length === 0 ? (
          <p className="text-muted-foreground px-5 py-4 text-sm">
            The agent has not written any files yet.
          </p>
        ) : (
          <div className="divide-y text-sm">
            {(files.data ?? []).map((file: ManagedWorkspaceFile) => {
              const retained = retainedFor(file)
              const working = busy && busyPath === file.path
              return (
                <div
                  key={file.path}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {file.path}
                  </span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {formatBytes(file.size)}
                  </span>
                  {retained ? (
                    <span
                      className="text-muted-foreground flex items-center gap-1 text-xs"
                      title={`sha256 ${retained.sha256}`}
                    >
                      <FileCheck2 className="size-3.5" /> retained
                    </span>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      retained
                        ? download.mutate(retained)
                        : exportThenDownload.mutate(file)
                    }
                  >
                    {working ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Download className="size-3.5" />
                    )}
                    Download
                  </Button>
                  {!retained ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => exportFile.mutate(file.path)}
                    >
                      Retain
                    </Button>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </Panel>

      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Retained artifacts</PanelTitle>
            <PanelDescription className="mt-1">
              Manifests kept after the session ends. Each download is checked
              against its byte count and SHA-256.
            </PanelDescription>
          </div>
        </PanelHeader>
        {artifacts.isLoading ? (
          <div className="flex min-h-24 items-center justify-center">
            <Loader2 className="text-muted-foreground size-4 animate-spin" />
          </div>
        ) : artifacts.isError ? (
          <div className="flex items-center gap-3 px-5 py-4 text-sm">
            <p className="text-status-error">
              Retained artifacts could not be loaded.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void artifacts.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (artifacts.data ?? []).length === 0 ? (
          <p className="text-muted-foreground px-5 py-4 text-sm">
            No files have been retained from this session.
          </p>
        ) : (
          <div className="divide-y text-sm">
            {(artifacts.data ?? []).map((artifact) => (
              <div
                key={artifact.id}
                className="grid gap-x-4 gap-y-1 px-5 py-3 md:grid-cols-[1fr_auto_auto]"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs">{artifact.path}</p>
                  <p className="text-muted-foreground mt-0.5 truncate font-mono text-[11px]">
                    sha256 {artifact.sha256}
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {artifact.id} · {formatBytes(artifact.size)} · exported{' '}
                    {new Date(artifact.exportedAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-start md:col-start-3">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => download.mutate(artifact)}
                  >
                    {download.isPending &&
                    download.variables?.id === artifact.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Download className="size-3.5" />
                    )}
                    Download
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}

function latestRetainedByPath(
  artifacts: ManagedWorkspaceArtifact[],
): ManagedWorkspaceArtifact[] {
  const latest = new Map<string, ManagedWorkspaceArtifact>()
  for (const artifact of artifacts) {
    const current = latest.get(artifact.path)
    if (!current || current.exportedAt < artifact.exportedAt) {
      latest.set(artifact.path, artifact)
    }
  }
  return [...latest.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Compact workspace listing for the playground debug inspector: the same
 * verified export-then-download path as the Files tab, one row per file.
 */
export function WorkspaceFilesInspector({
  sessionId,
  live,
}: {
  sessionId: string
  live: boolean
}) {
  const {
    files,
    artifacts,
    retainedFor,
    download,
    exportThenDownload,
    downloadAll,
    archiveProgress,
    busy,
    busyPath,
  } = useWorkspaceFiles(sessionId, live)
  const list = files.data ?? []
  // Once the workspace is gone (session ended), the retained copies are all
  // that is left to offer; newest export per path.
  const retainedOnly = files.isError
    ? latestRetainedByPath(artifacts.data ?? [])
    : []

  return (
    <details open className="group bg-background rounded-md border">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium [&::-webkit-details-marker]:hidden">
        <FolderDown className="size-3.5" /> Workspace files
        <span className="text-muted-foreground font-mono text-[9px]">
          {list.length}
        </span>
        <ChevronRight className="ml-auto size-3.5 transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t">
        <div className="flex items-center gap-2 px-3 py-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !list.length}
            onClick={() => downloadAll.mutate(list)}
          >
            {downloadAll.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FolderDown className="size-3.5" />
            )}
            {archiveProgress ?? 'Download all'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void files.refetch()}
            disabled={files.isFetching}
            aria-label="Refresh workspace files"
          >
            <RefreshCw
              className={
                files.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'
              }
            />
          </Button>
        </div>
        <div className="max-h-72 overflow-y-auto border-t">
          {files.isLoading ? (
            <div className="flex min-h-16 items-center justify-center">
              <Loader2 className="text-muted-foreground size-4 animate-spin" />
            </div>
          ) : files.isError && retainedOnly.length > 0 ? (
            <div className="divide-y">
              <p className="text-muted-foreground px-3 py-1.5 text-[10px]">
                Workspace listing is unavailable; showing retained copies.
              </p>
              {retainedOnly.map((artifact) => (
                <div
                  key={artifact.id}
                  className="flex items-center gap-2 px-3 py-1.5"
                >
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[10px]"
                    title={`sha256 ${artifact.sha256}`}
                  >
                    {artifact.path}
                  </span>
                  <FileCheck2 className="text-muted-foreground size-3" />
                  <span className="text-muted-foreground text-[10px] tabular-nums">
                    {formatBytes(artifact.size)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Download ${artifact.path}`}
                    onClick={() => download.mutate(artifact)}
                  >
                    {busy && busyPath === artifact.path ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Download className="size-3.5" />
                    )}
                  </Button>
                </div>
              ))}
            </div>
          ) : files.isError ? (
            <p className="text-status-error px-3 py-2 text-xs">
              Workspace listing is unavailable.
            </p>
          ) : list.length === 0 ? (
            <p className="text-muted-foreground px-3 py-2 text-xs">
              The agent has not written any files yet.
            </p>
          ) : (
            <div className="divide-y">
              {list.map((file: ManagedWorkspaceFile) => {
                const retained = retainedFor(file)
                const working = busy && busyPath === file.path
                return (
                  <div
                    key={file.path}
                    className="flex items-center gap-2 px-3 py-1.5"
                  >
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[10px]"
                      title={retained ? `sha256 ${retained.sha256}` : file.path}
                    >
                      {file.path}
                    </span>
                    {retained ? (
                      <FileCheck2 className="text-muted-foreground size-3" />
                    ) : null}
                    <span className="text-muted-foreground text-[10px] tabular-nums">
                      {formatBytes(file.size)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`Download ${file.path}`}
                      onClick={() =>
                        retained
                          ? download.mutate(retained)
                          : exportThenDownload.mutate(file)
                      }
                    >
                      {working ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Download className="size-3.5" />
                      )}
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </details>
  )
}
