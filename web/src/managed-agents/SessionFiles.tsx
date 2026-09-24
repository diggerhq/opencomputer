import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FileCheck2, Loader2, RefreshCw } from 'lucide-react'
import {
  Panel,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  downloadManagedAgentWorkspaceArtifact,
  exportManagedAgentWorkspaceFile,
  getManagedAgentWorkspaceArtifacts,
  getManagedAgentWorkspaceFiles,
  type ManagedWorkspaceArtifact,
  type ManagedWorkspaceFile,
} from './api'

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

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

function fileName(path: string) {
  return path.split('/').pop() ?? path
}

/**
 * Files the agent wrote under /workspace and the ones the provider has
 * retained. "Export" asks the provider to copy and hash a file; "Download"
 * fetches the retained bytes and verifies them against the manifest.
 */
export function SessionFiles({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient()
  const artifactsKey = ['managed-agent-session-artifacts', sessionId]
  const filesKey = ['managed-agent-session-workspace-files', sessionId]
  const files = useQuery({
    queryKey: filesKey,
    queryFn: () => getManagedAgentWorkspaceFiles(sessionId),
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
    mutationFn: async (artifact: ManagedWorkspaceArtifact) => {
      saveBlob(
        await downloadManagedAgentWorkspaceArtifact(artifact),
        fileName(artifact.path),
      )
      return artifact
    },
    onError: (error) => notifyError("Couldn't download that file.", error),
  })

  const exportThenDownload = useMutation({
    mutationFn: async (path: string) => {
      const artifact = await exportManagedAgentWorkspaceFile(sessionId, path)
      void queryClient.invalidateQueries({ queryKey: artifactsKey })
      saveBlob(
        await downloadManagedAgentWorkspaceArtifact(artifact),
        fileName(artifact.path),
      )
      return artifact
    },
    onError: (error) => notifyError("Couldn't download that file.", error),
  })

  const retainedByPath = new Map<string, ManagedWorkspaceArtifact>()
  for (const artifact of artifacts.data ?? []) {
    if (!retainedByPath.has(artifact.path)) {
      retainedByPath.set(artifact.path, artifact)
    }
  }
  const busy =
    exportFile.isPending || download.isPending || exportThenDownload.isPending
  const busyPath =
    exportFile.variables ??
    exportThenDownload.variables ??
    download.variables?.path

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
              const retained = retainedByPath.get(file.path)
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
                        : exportThenDownload.mutate(file.path)
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
