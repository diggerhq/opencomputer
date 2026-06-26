import { Fragment, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getCheckpoints, deleteCheckpointDashboard, type CheckpointItem } from '../api/client'

function checkpointTypeLabel(cp: CheckpointItem) {
  return cp.kind === 'disk_only' ? 'Disk-only' : 'Full'
}

function checkpointTypeDetail(cp: CheckpointItem) {
  if (cp.kind !== 'disk_only') {
    return 'Disk, memory, CPU'
  }
  if (cp.promotionStatus === 'ready') {
    return 'Promoted for fast fork'
  }
  if (cp.promotionStatus === 'processing' || cp.promotionStatus === 'pending') {
    return 'Promoting'
  }
  if (cp.promotionStatus === 'failed') {
    return 'Promotion failed'
  }
  return 'Disk only'
}

export default function Checkpoints() {
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [showFailed, setShowFailed] = useState(false)
  const perPage = 20

  const { data, isLoading } = useQuery({
    queryKey: ['checkpoints', page],
    queryFn: () => getCheckpoints(page, perPage),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCheckpointDashboard(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['checkpoints'] })
    },
  })

  const checkpoints = data?.checkpoints ?? []
  const visibleCheckpoints = useMemo(() => {
    if (!showFailed) {
      return checkpoints.filter((cp) => cp.status !== 'failed')
    }

    return checkpoints
      .map((cp, index) => ({ cp, index }))
      .sort((a, b) => {
        const aFailed = a.cp.status === 'failed'
        const bFailed = b.cp.status === 'failed'
        if (aFailed !== bFailed) return aFailed ? 1 : -1
        return a.index - b.index
      })
      .map(({ cp }) => cp)
  }, [checkpoints, showFailed])
  const total = data?.total ?? 0
  const totalPages = Math.ceil(total / perPage)

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h1 className="page-title">Checkpoints</h1>
        <p className="page-subtitle">Sandbox snapshots across your organization</p>
      </div>

      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 12,
          fontSize: 13,
          color: 'var(--text-secondary)',
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={showFailed}
          onChange={(event) => setShowFailed(event.target.checked)}
        />
        Show failed checkpoints
      </label>

      {/* Table */}
      {isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <div className="loading-spinner" />
        </div>
      ) : (
        <div className="glass-card animate-in stagger-1" style={{ overflow: 'hidden' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Sandbox</th>
                <th>Type</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Active Forks</th>
                <th style={{ textAlign: 'right' }}>Total Forks</th>
                <th>Created</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {visibleCheckpoints.map((cp: CheckpointItem) => (
                <Fragment key={cp.id}>
                  <tr>
                    <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{cp.name}</td>
                    <td>
                      <code style={{ fontSize: 12 }}>{cp.sandboxId}</code>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            padding: '2px 8px',
                            borderRadius: 10,
                            width: 'fit-content',
                            background: cp.kind === 'disk_only'
                              ? 'rgba(59, 130, 246, 0.08)'
                              : 'rgba(148, 163, 184, 0.08)',
                            color: cp.kind === 'disk_only'
                              ? '#60a5fa'
                              : 'var(--text-secondary)',
                            border: `1px solid ${
                              cp.kind === 'disk_only'
                                ? 'rgba(59, 130, 246, 0.18)'
                                : 'rgba(148, 163, 184, 0.16)'
                            }`,
                          }}
                        >
                          {checkpointTypeLabel(cp)}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                          {checkpointTypeDetail(cp)}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          padding: '2px 8px',
                          borderRadius: 10,
                          background: cp.status === 'ready'
                            ? 'rgba(34, 197, 94, 0.08)'
                            : cp.status === 'failed'
                              ? 'rgba(251, 113, 133, 0.08)'
                              : 'rgba(234, 179, 8, 0.08)',
                          color: cp.status === 'ready'
                            ? 'var(--accent-green)'
                            : cp.status === 'failed'
                              ? 'var(--accent-rose)'
                              : '#eab308',
                          border: `1px solid ${
                            cp.status === 'ready'
                              ? 'rgba(34, 197, 94, 0.15)'
                              : cp.status === 'failed'
                                ? 'rgba(251, 113, 133, 0.15)'
                                : 'rgba(234, 179, 8, 0.15)'
                          }`,
                        }}
                      >
                        {cp.status === 'ready' ? 'Ready' : cp.status === 'failed' ? 'Failed' : 'Processing'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                      {cp.activeForks > 0 ? (
                        <span style={{ color: 'var(--accent-emerald)' }}>{cp.activeForks}</span>
                      ) : (
                        <span style={{ color: 'var(--text-tertiary)' }}>0</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
                      {cp.totalForks}
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                      {new Date(cp.createdAt).toLocaleString()}
                    </td>
                    <td>
                      <button
                        className="btn-danger"
                        onClick={() => {
                          if (confirm(`Delete checkpoint "${cp.name}"? Active forks will not be affected.`)) {
                            deleteMutation.mutate(cp.id)
                          }
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                  {cp.status === 'failed' && cp.errorMsg && (
                    <tr key={`${cp.id}-error`}>
                      <td colSpan={8} style={{ paddingTop: 0 }}>
                        <div
                          style={{
                            border: '1px solid rgba(251, 113, 133, 0.16)',
                            borderRadius: 8,
                            padding: '10px 12px',
                            background: 'rgba(251, 113, 133, 0.06)',
                            color: 'var(--accent-rose)',
                            fontSize: 12,
                            lineHeight: 1.45,
                            overflowWrap: 'anywhere',
                          }}
                        >
                          {cp.errorMsg}
                          {cp.failedAt && (
                            <div style={{ color: 'var(--text-tertiary)', marginTop: 4 }}>
                              Failed {new Date(cp.failedAt).toLocaleString()}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {visibleCheckpoints.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: 32, color: 'var(--text-tertiary)' }}>
                    {checkpoints.length === 0 ? 'No checkpoints yet' : 'No checkpoints to show'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              borderTop: '1px solid var(--border-subtle)',
              fontSize: 12,
              color: 'var(--text-secondary)',
            }}>
              <span>{total} checkpoint{total !== 1 ? 's' : ''}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  className="btn-ghost"
                  disabled={page <= 1}
                  onClick={() => setPage(p => p - 1)}
                  style={{ padding: '4px 10px', fontSize: 12 }}
                >
                  Prev
                </button>
                <span style={{ padding: '4px 8px', lineHeight: '24px' }}>
                  {page} / {totalPages}
                </span>
                <button
                  className="btn-ghost"
                  disabled={page >= totalPages}
                  onClick={() => setPage(p => p + 1)}
                  style={{ padding: '4px 10px', fontSize: 12 }}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
