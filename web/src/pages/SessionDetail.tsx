import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getSessionDetail, getSessionStats, saveAsTemplate } from '../api/client'
import Terminal from '../components/Terminal'

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'running' ? 'badge-running' :
    status === 'stopped' ? 'badge-stopped' :
    status === 'hibernated' ? 'badge-hibernated' :
    status === 'error' ? 'badge-error' : ''

  return <span className={`status-badge ${cls}`}>{status}</span>
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-md)',
      padding: '16px 20px',
      flex: 1,
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
          {sub}
        </div>
      )}
    </div>
  )
}

export default function SessionDetail() {
  const { sandboxId } = useParams<{ sandboxId: string }>()
  const navigate = useNavigate()
  const [copied, setCopied] = useState(false)
  const [showTerminal, setShowTerminal] = useState(false)
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null)

  const { data: session, isLoading } = useQuery({
    queryKey: ['session-detail', sandboxId],
    queryFn: () => getSessionDetail(sandboxId!),
    enabled: !!sandboxId,
  })

  const { data: stats } = useQuery({
    queryKey: ['session-stats', sandboxId],
    queryFn: () => getSessionStats(sandboxId!),
    enabled: !!sandboxId && session?.status === 'running',
    refetchInterval: 5000,
    retry: false,
  })

  const copyUrl = () => {
    if (session?.domain) {
      navigator.clipboard.writeText(`https://${session.domain}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleSaveAsTemplate = async () => {
    if (!sandboxId || !templateName.trim()) return
    setSaving(true)
    setSaveError(null)
    try {
      const tmpl = await saveAsTemplate(sandboxId, templateName.trim())
      setSaveSuccess(`Template "${tmpl.name}" saved — drives are uploading to S3 in the background.`)
      setShowSaveModal(false)
      setTemplateName('')
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <div className="loading-spinner" />
      </div>
    )
  }

  if (!session) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)' }}>
        Session not found
      </div>
    )
  }

  return (
    <div>
      {/* Back link */}
      <button
        onClick={() => navigate('/sessions')}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--text-tertiary)', fontSize: 13, padding: 0,
          marginBottom: 20, display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5" /><polyline points="12 19 5 12 12 5" />
        </svg>
        Back to Sessions
      </button>

      {/* Header */}
      <div className="glass-card animate-in" style={{ padding: 24, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <code style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                {session.sandboxId}
              </code>
              <StatusBadge status={session.status} />
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
              {session.template || 'base'} &middot; Started {timeAgo(session.startedAt)}
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8 }}>
            {session.status === 'running' && (
              <>
                <button
                  className={showTerminal ? 'btn-primary' : 'btn-ghost'}
                  onClick={() => setShowTerminal(!showTerminal)}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 17 10 11 4 5" />
                    <line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                  Terminal
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => { setShowSaveModal(true); setSaveError(null) }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                    <polyline points="17 21 17 13 7 13 7 21" />
                    <polyline points="7 3 7 8 15 8" />
                  </svg>
                  Save as Template
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Save as Template success banner */}
      {saveSuccess && (
        <div className="animate-in" style={{
          background: 'rgba(74,222,128,0.08)',
          border: '1px solid rgba(74,222,128,0.3)',
          borderRadius: 'var(--radius-md)',
          padding: '12px 16px',
          marginBottom: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 13,
          color: 'var(--text-primary)',
        }}>
          <span>{saveSuccess}</span>
          <button
            onClick={() => setSaveSuccess(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: 16, lineHeight: 1 }}
          >×</button>
        </div>
      )}

      {/* Save as Template modal */}
      {showSaveModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div className="glass-card" style={{ padding: 28, width: 420, maxWidth: '90vw' }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
              Save as Template
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20 }}>
              Snapshots the current filesystem state of <code style={{ fontFamily: 'var(--font-mono)' }}>{session.sandboxId}</code> (installed packages + workspace files).
              The sandbox continues running. A new template will appear in your Templates list once the upload finishes.
            </div>

            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
              Template name
            </label>
            <input
              autoFocus
              value={templateName}
              onChange={e => setTemplateName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveAsTemplate() }}
              placeholder="e.g. my-node-env"
              style={{
                width: '100%', boxSizing: 'border-box',
                background: 'var(--bg-deep)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                padding: '10px 12px',
                fontSize: 13, color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
                marginBottom: saveError ? 10 : 20,
                outline: 'none',
              }}
            />
            {saveError && (
              <div style={{ fontSize: 12, color: 'var(--accent-rose)', marginBottom: 16 }}>{saveError}</div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                className="btn-ghost"
                onClick={() => { setShowSaveModal(false); setTemplateName(''); setSaveError(null) }}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={handleSaveAsTemplate}
                disabled={saving || !templateName.trim()}
              >
                {saving ? 'Saving…' : 'Save Template'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Terminal */}
      {showTerminal && session.status === 'running' && (
        <div className="glass-card animate-in" style={{ padding: 20, marginBottom: 16 }}>
          <Terminal sandboxId={sandboxId!} onClose={() => setShowTerminal(false)} />
        </div>
      )}

      {/* Stats cards — only for running sandboxes */}
      {session.status === 'running' && (
        <div className="glass-card animate-in stagger-1" style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 14 }}>
            Resource Usage
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <StatCard
              label="CPU"
              value={stats ? `${stats.cpuPercent.toFixed(1)}%` : '—'}
            />
            <StatCard
              label="Memory"
              value={stats ? formatBytes(stats.memUsage) : '—'}
              sub={stats ? `of ${formatBytes(stats.memLimit)}` : undefined}
            />
            <StatCard
              label="Processes"
              value={stats ? String(stats.pids) : '—'}
            />
            <StatCard
              label="Network"
              value={stats ? `↑${formatBytes(stats.netOutput)}` : '—'}
              sub={stats ? `↓${formatBytes(stats.netInput)}` : undefined}
            />
          </div>
        </div>
      )}

      {/* Live URL */}
      {session.domain && (session.status === 'running' || session.status === 'hibernated') && (
        <div className="glass-card animate-in stagger-2" style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
            Live URL
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              flex: 1,
              background: 'var(--bg-deep)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 14px',
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              color: 'var(--text-accent)',
            }}>
              <a
                href={`https://${session.domain}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--text-accent)', textDecoration: 'none' }}
              >
                https://{session.domain}
              </a>
            </div>
            <button className="btn-ghost" onClick={copyUrl} style={{ whiteSpace: 'nowrap' }}>
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {/* Details */}
      <div className="glass-card animate-in stagger-3" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 14 }}>
          Details
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 32px' }}>
          <DetailRow label="Template" value={session.template || 'base'} />
          <DetailRow label="Timeout" value={session.config?.timeout ? `${session.config.timeout}s` : '300s'} />
          <DetailRow label="CPUs" value={String(session.config?.cpuCount ?? 1)} />
          <DetailRow label="Memory" value={`${session.config?.memoryMB ?? 512} MB`} />
          <DetailRow label="Network" value={session.config?.networkEnabled ? 'Enabled' : 'Disabled'} />
          <DetailRow label="Started" value={new Date(session.startedAt).toLocaleString()} />
          {session.stoppedAt && (
            <DetailRow label="Stopped" value={new Date(session.stoppedAt).toLocaleString()} />
          )}
          {session.errorMsg && (
            <DetailRow label="Error" value={session.errorMsg} isError />
          )}
        </div>
      </div>

      {/* Checkpoint info for hibernated */}
      {session.checkpoint && (
        <div className="glass-card animate-in stagger-4" style={{ padding: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 14 }}>
            Checkpoint
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 32px' }}>
            <DetailRow label="Size" value={formatBytes(session.checkpoint.sizeBytes)} />
            <DetailRow label="Hibernated" value={new Date(session.checkpoint.hibernatedAt).toLocaleString()} />
          </div>
        </div>
      )}
    </div>
  )
}

function DetailRow({ label, value, isError }: { label: string; value: string; isError?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>{label}</div>
      <div style={{
        fontSize: 13,
        fontFamily: 'var(--font-mono)',
        color: isError ? 'var(--accent-rose)' : 'var(--text-primary)',
        wordBreak: 'break-all',
      }}>
        {value}
      </div>
    </div>
  )
}
