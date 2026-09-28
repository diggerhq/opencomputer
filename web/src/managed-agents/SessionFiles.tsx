import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  ChevronRight,
  Download,
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
  authorizeManagedAgentWorkspaceDownload,
  downloadManagedAgentWorkspaceArchive,
  downloadManagedAgentWorkspaceFile,
  getManagedAgentWorkspaceFiles,
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

function reportDownloadError(error: unknown) {
  if (error instanceof DownloadCancelled) return
  notifyError("Couldn't download that file.", error)
}

/**
 * Workspace listing and direct download actions shared by the session Files
 * tab and the playground debug inspector.
 */
function useWorkspaceFiles(sessionId: string, live: boolean) {
  const filesKey = ['managed-agent-session-workspace-files', sessionId]
  const files = useQuery({
    queryKey: filesKey,
    queryFn: () => getManagedAgentWorkspaceFiles(sessionId),
    refetchInterval: live ? 5_000 : false,
  })
  const directDownload = useMutation({
    mutationFn: (file: ManagedWorkspaceFile) =>
      downloadManagedAgentWorkspaceFile(sessionId, file),
    onError: reportDownloadError,
  })

  const [archiveProgress, setArchiveProgress] = useState<string | null>(null)
  const downloadAll = useMutation({
    mutationFn: (workspace: ManagedWorkspaceFile[]) =>
      downloadManagedAgentWorkspaceArchive(
        `${sessionId}-workspace.zip`,
        workspace,
        (file) => authorizeManagedAgentWorkspaceDownload(sessionId, file.path),
        (done, total) => setArchiveProgress(`Downloading ${done}/${total}`),
      ),
    onSuccess: (downloads) =>
      notifySuccess(`Downloaded ${downloads.length} files.`),
    onError: reportDownloadError,
    onSettled: () => setArchiveProgress(null),
  })

  const busy = directDownload.isPending || downloadAll.isPending
  const busyPath = directDownload.variables?.path

  return {
    files,
    directDownload,
    downloadAll,
    archiveProgress,
    busy,
    busyPath,
  }
}

/**
 * Files the agent wrote under /workspace. Downloads use a short-lived URL to
 * stream directly from the file edge.
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
    directDownload,
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
              sandbox. Newly written files appear gradually and may take a few
              moments to finish syncing. Downloads stream directly from our file
              delivery edge.
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
            No files are visible yet. Newly written files may take a few moments
            to finish syncing.
          </p>
        ) : (
          <div className="divide-y text-sm">
            {(files.data ?? []).map((file: ManagedWorkspaceFile) => {
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
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => directDownload.mutate(file)}
                  >
                    {working ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Download className="size-3.5" />
                    )}
                    Download
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </Panel>
    </div>
  )
}

/**
 * Compact workspace listing for the playground debug inspector: the same
 * direct-download path as the Files tab, one row per file.
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
    directDownload,
    downloadAll,
    archiveProgress,
    busy,
    busyPath,
  } = useWorkspaceFiles(sessionId, live)
  const list = files.data ?? []

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
        <p className="text-muted-foreground border-t px-3 py-1.5 text-[10px]">
          Newly written files appear gradually and may take a few moments to
          finish syncing.
        </p>
        <div className="max-h-72 overflow-y-auto border-t">
          {files.isLoading ? (
            <div className="flex min-h-16 items-center justify-center">
              <Loader2 className="text-muted-foreground size-4 animate-spin" />
            </div>
          ) : files.isError ? (
            <p className="text-status-error px-3 py-2 text-xs">
              Workspace listing is unavailable.
            </p>
          ) : list.length === 0 ? (
            <p className="text-muted-foreground px-3 py-2 text-xs">
              No files are visible yet. Try refreshing in a few moments.
            </p>
          ) : (
            <div className="divide-y">
              {list.map((file: ManagedWorkspaceFile) => {
                const working = busy && busyPath === file.path
                return (
                  <div
                    key={file.path}
                    className="flex items-center gap-2 px-3 py-1.5"
                  >
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[10px]"
                      title={file.path}
                    >
                      {file.path}
                    </span>
                    <span className="text-muted-foreground text-[10px] tabular-nums">
                      {formatBytes(file.size)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`Download ${file.path}`}
                      onClick={() => directDownload.mutate(file)}
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
