import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getSessions, type Session } from '../api/client'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { generateSessionTimeline } from '../data/mockData'

const statusFilters = ['', 'running', 'stopped', 'error'] as const

/* ── Tooltip ──────────────────────────────────────────────── */
function TimelineTooltip({ active, payload, label }: {
  active?: boolean
  payload?: Array<{ name: string; value: number; color: string }>
  label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'rgba(8,8,12,0.92)', backdropFilter: 'blur(14px)',
      border: '1px solid var(--border-accent)', borderRadius: 10,
      padding: '10px 14px', boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
    }}>
      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginBottom: 6 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 2 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
          <span style={{ color: 'var(--text-secondary)' }}>{p.name}</span>
          <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontWeight: 600, marginLeft: 'auto' }}>{p.value}</span>
        </div>
      ))}
    </div>
  )
}

/* ── Main ─────────────────────────────────────────────────── */
export default function Sessions() {
  const [status, setStatus] = useState<string>('')
  const { data: sessions, isLoading } = useQuery({
    queryKey: ['sessions', status],
    queryFn: () => getSessions(status || undefined),
  })

  const timeline = useMemo(() => generateSessionTimeline(), [])

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 className="page-title">Sessions</h1>
        <p className="page-subtitle">Session history and activity timeline</p>
      </div>

      {/* ── Timeline Chart ── */}
      <div className="glass-card animate-in stagger-1" style={{ padding: '22px 24px', marginBottom: 22 }}>
        <span className="section-title">Activity — Last 24 Hours</span>
        <ResponsiveContainer width="100%" height={190}>
          <BarChart data={timeline} barGap={1}>
            <defs>
              <linearGradient id="gStarted" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#818cf8" stopOpacity={0.85} />
                <stop offset="100%" stopColor="#818cf8" stopOpacity={0.45} />
              </linearGradient>
              <linearGradient id="gStopped" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#8585a0" stopOpacity={0.6} />
                <stop offset="100%" stopColor="#8585a0" stopOpacity={0.25} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="hour" tick={{ fontSize: 9 }} axisLine={{ stroke: 'rgba(255,255,255,0.05)' }} tickLine={false} interval={2} />
            <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
            <Tooltip content={<TimelineTooltip />} />
            <Legend
              iconType="circle"
              iconSize={7}
              wrapperStyle={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-body)' }}
            />
            <Bar dataKey="started" name="Started" fill="url(#gStarted)" radius={[3, 3, 0, 0]} />
            <Bar dataKey="stopped" name="Stopped" fill="url(#gStopped)" radius={[3, 3, 0, 0]} />
            <Bar dataKey="errors" name="Errors" fill="#fb718544" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* ── Filters ── */}
      <div style={{ marginBottom: 16, display: 'flex', gap: 6 }}>
        {statusFilters.map(f => (
          <button key={f} onClick={() => setStatus(f)}
            className={`filter-btn${status === f ? ' active' : ''}`}>
            {f || 'All'}
          </button>
        ))}
      </div>

      {/* ── Table ── */}
      {isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <div className="loading-spinner" />
        </div>
      ) : (
        <div className="glass-card animate-in stagger-2" style={{ overflow: 'hidden' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Sandbox ID</th>
                <th>Template</th>
                <th>Region</th>
                <th>Status</th>
                <th>Started</th>
                <th>Stopped</th>
              </tr>
            </thead>
            <tbody>
              {(sessions ?? []).map((s: Session) => (
                <tr key={s.id}>
                  <td><code>{s.sandboxId}</code></td>
                  <td>{s.template || 'base'}</td>
                  <td>{s.region}</td>
                  <td><StatusBadge status={s.status} /></td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{new Date(s.startedAt).toLocaleString()}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{s.stoppedAt ? new Date(s.stoppedAt).toLocaleString() : '\u2014'}</td>
                </tr>
              ))}
              {(sessions ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: 32, color: 'var(--text-tertiary)' }}>
                    No sessions found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'running' ? 'badge-running'
    : status === 'error' ? 'badge-error'
    : 'badge-stopped'
  return (
    <span className={`badge ${cls}`}>
      {status === 'running' && (
        <span className="pulse-dot" style={{
          width: 5, height: 5, borderRadius: '50%',
          background: 'currentColor', display: 'inline-block',
        }} />
      )}
      {status}
    </span>
  )
}
