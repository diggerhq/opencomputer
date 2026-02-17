import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getSessions, type Session } from '../api/client'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line,
} from 'recharts'
import {
  generateUsageData, generateTemplateData, generateRegionData,
  generateSparkData, generateDemoSandboxes, CHART_COLORS,
} from '../data/mockData'

/* ── Custom Tooltip ───────────────────────────────────────── */
function ChartTooltip({ active, payload, label }: {
  active?: boolean
  payload?: Array<{ name: string; value: number; color: string }>
  label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'rgba(8, 8, 12, 0.92)',
      backdropFilter: 'blur(14px)',
      border: '1px solid var(--border-accent)',
      borderRadius: 10,
      padding: '10px 14px',
      boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
    }}>
      <div style={{
        fontSize: 10, color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-mono)', marginBottom: 6,
      }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 2 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
          <span style={{ color: 'var(--text-secondary)' }}>{p.name}</span>
          <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontWeight: 600, marginLeft: 'auto' }}>
            {p.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  )
}

/* ── Main Dashboard ───────────────────────────────────────── */
export default function Dashboard() {
  const [timeRange, setTimeRange] = useState<7 | 30>(7)

  const { data: sessions, isLoading } = useQuery({
    queryKey: ['sessions', 'running'],
    queryFn: () => getSessions('running'),
  })

  const activeSandboxes = sessions ?? []

  const usageData = useMemo(() => generateUsageData(timeRange), [timeRange])
  const templateData = useMemo(() => generateTemplateData(), [])
  const regionData = useMemo(() => generateRegionData(), [])
  const sparkActive = useMemo(() => generateSparkData(10, 24, 'up'), [])
  const sparkSessions = useMemo(() => generateSparkData(20, 24, 'up'), [])
  const sparkUptime = useMemo(() => generateSparkData(30, 24, 'stable'), [])
  const sparkAPI = useMemo(() => generateSparkData(40, 24, 'up'), [])

  const templateTotal = templateData.reduce((s, t) => s + t.value, 0)
  const liveList = activeSandboxes.length > 0 ? activeSandboxes : generateDemoSandboxes()

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <h1 className="page-title">Dashboard</h1>
        <p className="page-subtitle">Real-time overview of your sandbox infrastructure</p>
      </div>

      {/* ── Stat Cards ── */}
      <div className="grid-stats" style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 24,
      }}>
        <StatCard label="Active Sandboxes" value={activeSandboxes.length || 24} change="+12%" up sparkData={sparkActive} color={CHART_COLORS[0]} idx={0} />
        <StatCard label="Sessions Today" value={847} change="+23%" up sparkData={sparkSessions} color={CHART_COLORS[1]} idx={1} />
        <StatCard label="Avg Uptime" value="99.7%" change="+0.2%" up sparkData={sparkUptime} color={CHART_COLORS[2]} idx={2} />
        <StatCard label="API Calls (24h)" value="12.4k" change="+18%" up sparkData={sparkAPI} color={CHART_COLORS[4]} idx={3} />
      </div>

      {/* ── Main Charts Row ── */}
      <div className="grid-charts-main" style={{
        display: 'grid', gridTemplateColumns: '5fr 2fr', gap: 14, marginBottom: 24,
      }}>
        {/* Area — Usage Over Time */}
        <div className="glass-card animate-in stagger-5" style={{ padding: '22px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
            <span className="section-title" style={{ marginBottom: 0 }}>Usage Over Time</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {([7, 30] as const).map(d => (
                <button key={d} onClick={() => setTimeRange(d)}
                  className={`filter-btn${timeRange === d ? ' active' : ''}`}
                  style={{ padding: '3px 12px', fontSize: 11 }}>
                  {d}d
                </button>
              ))}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={270}>
            <AreaChart data={usageData}>
              <defs>
                <linearGradient id="gSandboxes" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#818cf8" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="#818cf8" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gSessions" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#34d399" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" tick={{ fontSize: 10 }} axisLine={{ stroke: 'rgba(255,255,255,0.05)' }} tickLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={36} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="sessions" name="Sessions" stroke="#34d399" strokeWidth={1.5} fill="url(#gSessions)" />
              <Area type="monotone" dataKey="sandboxes" name="Sandboxes" stroke="#818cf8" strokeWidth={2} fill="url(#gSandboxes)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Donut — Template Distribution */}
        <div className="glass-card animate-in stagger-5" style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column' }}>
          <span className="section-title">By Template</span>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ResponsiveContainer width="100%" height={175}>
              <PieChart>
                <Pie data={templateData} cx="50%" cy="50%" innerRadius={52} outerRadius={78}
                  paddingAngle={3} dataKey="value" stroke="none">
                  {templateData.map((e, i) => <Cell key={i} fill={e.color} />)}
                </Pie>
                <Tooltip content={<ChartTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 4 }}>
            {templateData.map(t => (
              <div key={t.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: t.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t.name}</span>
                </div>
                <span className="metric-value" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                  {Math.round((t.value / templateTotal) * 100)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Bottom Row ── */}
      <div className="grid-charts-secondary" style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14,
      }}>
        {/* Region Distribution */}
        <div className="glass-card" style={{ padding: '22px 24px' }}>
          <span className="section-title">By Region</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {regionData.map((r, i) => {
              const pct = (r.count / regionData[0].count) * 100
              return (
                <div key={r.region}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{r.label}</span>
                      <code style={{
                        fontSize: 10, color: 'var(--text-tertiary)',
                        fontFamily: 'var(--font-mono)',
                        background: 'rgba(255,255,255,0.03)', padding: '1px 5px', borderRadius: 3,
                      }}>{r.region}</code>
                    </div>
                    <span className="metric-value" style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                      {r.count}
                    </span>
                  </div>
                  <div style={{ height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.04)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', width: `${pct}%`, borderRadius: 3,
                      background: CHART_COLORS[i],
                      boxShadow: `0 0 8px ${CHART_COLORS[i]}33`,
                      transition: 'width 0.6s cubic-bezier(0.16,1,0.3,1)',
                    }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Live Sandboxes */}
        <div className="glass-card" style={{ padding: '22px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <span className="section-title" style={{ marginBottom: 0 }}>Live Sandboxes</span>
            <span style={{
              fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--accent-emerald)',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span className="pulse-dot" style={{
                width: 6, height: 6, borderRadius: '50%',
                background: 'var(--accent-emerald)', display: 'inline-block',
              }} />
              {liveList.length} active
            </span>
          </div>

          {isLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
              <div className="loading-spinner" />
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 270, overflowY: 'auto' }}>
              {liveList.map((s, i) => <SandboxRow key={s.id ?? i} session={s} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Stat Card w/ Sparkline ───────────────────────────────── */
function StatCard({ label, value, change, up, sparkData, color, idx }: {
  label: string
  value: number | string
  change: string
  up: boolean
  sparkData: { value: number }[]
  color: string
  idx: number
}) {
  const gradId = `spark-g-${idx}`
  return (
    <div className={`stat-card animate-in stagger-${idx + 1}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 8, letterSpacing: '0.03em' }}>{label}</div>
          <div className="metric-value" style={{ fontSize: 30, fontWeight: 700, lineHeight: 1 }}>{typeof value === 'number' ? value.toLocaleString() : value}</div>
        </div>
        <span style={{
          fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 500,
          color: up ? 'var(--accent-emerald)' : 'var(--accent-rose)',
          background: up ? 'rgba(52,211,153,0.08)' : 'rgba(251,113,133,0.08)',
          padding: '2px 8px', borderRadius: 10,
        }}>{change}</span>
      </div>
      <div style={{ height: 36, marginLeft: -6, marginRight: -6 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={sparkData}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={color} stopOpacity={0.15} />
                <stop offset="100%" stopColor={color} stopOpacity={0.9} />
              </linearGradient>
            </defs>
            <Line type="monotone" dataKey="value" stroke={`url(#${gradId})`} strokeWidth={1.8} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

/* ── Sandbox Row ──────────────────────────────────────────── */
function SandboxRow({ session }: { session: Session | ReturnType<typeof generateDemoSandboxes>[number] }) {
  const elapsed = Math.round((Date.now() - new Date(session.startedAt).getTime()) / 1000 / 60)
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '9px 12px', borderRadius: 8,
      background: 'rgba(255,255,255,0.015)',
      border: '1px solid rgba(255,255,255,0.035)',
      transition: 'all 0.15s ease', cursor: 'default',
    }}
    onMouseOver={e => {
      e.currentTarget.style.background = 'rgba(99,102,241,0.05)'
      e.currentTarget.style.borderColor = 'rgba(99,102,241,0.12)'
    }}
    onMouseOut={e => {
      e.currentTarget.style.background = 'rgba(255,255,255,0.015)'
      e.currentTarget.style.borderColor = 'rgba(255,255,255,0.035)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="pulse-dot" style={{
          width: 6, height: 6, borderRadius: '50%',
          background: 'var(--accent-emerald)', flexShrink: 0,
        }} />
        <div>
          <code style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-accent)' }}>
            {session.sandboxId}
          </code>
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 1 }}>
            {session.template || 'base'} &middot; {session.region}
          </div>
        </div>
      </div>
      <span className="metric-value" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
        {elapsed}m
      </span>
    </div>
  )
}
