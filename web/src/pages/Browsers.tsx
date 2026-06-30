import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Monitor, Trash2 } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import {
  deleteBrowser,
  getBrowserProfiles,
  getBrowsers,
  type BrowserProfile,
  type BrowserSession,
} from '@/api/client'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ResourceTable, type Column } from '@/components/resource-table'

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'deleted', label: 'Deleted' },
] as const

function canDeleteBrowser(browser: BrowserSession) {
  return browser.status === 'active' && !browser.deleted_at
}

function browserMode(browser: BrowserSession) {
  return browser.headless ? 'Headless' : 'Headful'
}

export default function Browsers() {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState('')
  const [toDelete, setToDelete] = useState<BrowserSession | null>(null)

  const {
    data: browsers = [],
    isLoading,
    error: browsersError,
  } = useQuery({
    queryKey: ['browsers', status],
    queryFn: () => getBrowsers({ status: status || undefined }),
    retry: false,
  })
  const { data: profiles = [], isLoading: loadingProfiles } = useQuery({
    queryKey: ['browser-profiles'],
    queryFn: getBrowserProfiles,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteBrowser(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['browsers'] })
      const deletedAt = new Date().toISOString()
      queryClient.setQueriesData<BrowserSession[]>(
        { queryKey: ['browsers'] },
        (old) =>
          old?.map((browser) =>
            browser.id === id
              ? {
                  ...browser,
                  status: 'deleted',
                  deleted_at: deletedAt,
                  updated_at: deletedAt,
                }
              : browser,
          ),
      )
    },
    onError: (error) => notifyError("Couldn't delete the browser.", error),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['browsers'] })
    },
  })

  const activeCount = useMemo(
    () => browsers.filter((browser) => canDeleteBrowser(browser)).length,
    [browsers],
  )
  const accessPlaceholder = browserAccessPlaceholder(browsersError)

  const confirmDelete = () => {
    if (!toDelete) return
    deleteMutation.mutate(toDelete.id, {
      onSuccess: () => setToDelete(null),
    })
  }

  const columns: Column<BrowserSession>[] = [
    {
      key: 'id',
      header: 'Browser',
      cell: (browser) => (
        <div className="min-w-0">
          <div className="text-foreground font-mono text-[13px]">
            {browser.id}
          </div>
          <div className="text-muted-foreground truncate font-mono text-xs">
            {browser.provider_session_id}
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (browser) => <StatusBadge status={browser.status} />,
    },
    {
      key: 'mode',
      header: 'Mode',
      cell: (browser) => (
        <span className="text-muted-foreground text-sm">
          {browserMode(browser)}
        </span>
      ),
    },
    {
      key: 'recording',
      header: 'Recording',
      cell: (browser) => (
        <span className="text-muted-foreground text-sm">
          {browser.replay_id ? 'On' : browser.headless ? 'Unavailable' : '—'}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      cell: (browser) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(browser.created_at).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (browser) => (
        <div className="flex h-8 items-center justify-end gap-1">
          {browser.live_view_url ? (
            <Button
              asChild
              variant="ghost"
              size="icon"
              title="Open live view"
              aria-label="Open live view"
            >
              <a
                href={browser.live_view_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="size-4" />
              </a>
            </Button>
          ) : null}
          {browser.replay_view_url ? (
            <Button
              asChild
              variant="ghost"
              size="icon"
              title="Open replay"
              aria-label="Open replay"
            >
              <a
                href={browser.replay_view_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Monitor className="size-4" />
              </a>
            </Button>
          ) : null}
          {canDeleteBrowser(browser) ? (
            <Button
              variant="ghost"
              size="icon"
              title="Delete browser"
              aria-label="Delete browser"
              className="text-status-error hover:text-destructive"
              onClick={() => setToDelete(browser)}
            >
              <Trash2 className="size-4" />
            </Button>
          ) : null}
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Browser sessions"
        description="Browser sessions, live views, and recordings."
        api={{
          method: 'POST',
          path: '/v1/browsers',
          sdk: 'Browser.create()',
          docs: 'https://docs.opencomputer.dev/browser-sessions/overview',
        }}
      />

      {accessPlaceholder ? (
        <BrowserAccessPlaceholder
          title={accessPlaceholder.title}
          description={accessPlaceholder.description}
        />
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Metric label="Visible sessions" value={browsers.length} />
            <Metric label="Active" value={activeCount} />
            <Metric label="Profiles" value={profiles.length} />
          </div>

          <div className="mb-4 flex flex-wrap gap-1.5">
            {STATUS_FILTERS.map((filter) => (
              <Button
                key={filter.value}
                size="sm"
                variant={status === filter.value ? 'default' : 'ghost'}
                onClick={() => setStatus(filter.value)}
              >
                {filter.label}
              </Button>
            ))}
          </div>

          <Panel className="mb-6 overflow-hidden">
            <ResourceTable
              columns={columns}
              rows={browsers}
              rowKey={(browser) => browser.id}
              loading={isLoading}
              empty={
                <EmptyState
                  icon={Monitor}
                  title="No browser sessions found"
                  description={
                    status
                      ? 'No browser sessions match this filter.'
                      : 'Browser sessions created through the API will show up here.'
                  }
                />
              }
            />
          </Panel>

          <ProfilesTable profiles={profiles} loading={loadingProfiles} />
        </>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title={`Delete browser ${toDelete?.id ?? ''}?`}
        description="The browser session will be stopped. Existing replay links remain available when recording was enabled."
        confirmLabel="Delete browser"
        destructive
        pending={deleteMutation.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <Panel className="px-4 py-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-foreground mt-1 font-mono text-2xl">{value}</div>
    </Panel>
  )
}

function browserAccessPlaceholder(error: unknown) {
  if (!(error instanceof Error)) return null
  const message = error.message.toLowerCase()
  if (
    message.includes('invite-only') ||
    message.includes('browser_preview_not_enabled')
  ) {
    return {
      title: 'Browser sessions are in preview',
      description:
        'This organization is not enabled for Browser Sessions yet. Approved organizations will see live and past browser sessions here.',
    }
  }
  if (message.includes('browser sessions proxy unavailable')) {
    return {
      title: 'Browser sessions are not configured',
      description:
        'The dashboard is ready, but the browser service token is not configured for this deployment.',
    }
  }
  return null
}

function BrowserAccessPlaceholder({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <Panel className="px-6 py-10">
      <EmptyState icon={Monitor} title={title} description={description} />
    </Panel>
  )
}

function ProfilesTable({
  profiles,
  loading,
}: {
  profiles: BrowserProfile[]
  loading: boolean
}) {
  const columns: Column<BrowserProfile>[] = [
    {
      key: 'name',
      header: 'Profile',
      cell: (profile) => (
        <div>
          <div className="text-foreground text-sm">
            {profile.name || 'Unnamed profile'}
          </div>
          <div className="text-muted-foreground font-mono text-xs">
            {profile.id}
          </div>
        </div>
      ),
    },
    {
      key: 'provider',
      header: 'Provider profile',
      cell: (profile) => (
        <span className="text-muted-foreground font-mono text-xs">
          {profile.provider_profile_id}
        </span>
      ),
    },
    {
      key: 'lastUsed',
      header: 'Last used',
      cell: (profile) => (
        <span className="text-muted-foreground font-mono text-xs">
          {profile.provider_last_used_at
            ? new Date(profile.provider_last_used_at).toLocaleString()
            : '—'}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      cell: (profile) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(profile.created_at).toLocaleString()}
        </span>
      ),
    },
  ]

  return (
    <Panel className="overflow-hidden">
      <ResourceTable
        columns={columns}
        rows={profiles}
        rowKey={(profile) => profile.id}
        loading={loading}
        empty={
          <EmptyState
            icon={Monitor}
            title="No browser profiles"
            description="Saved browser profiles will show up here."
          />
        }
      />
    </Panel>
  )
}
