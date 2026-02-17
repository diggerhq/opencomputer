/**
 * Deterministic mock data for dashboard charts.
 * Uses a seeded PRNG so charts look consistent across renders.
 * Replace with real API calls when endpoints exist.
 */

function createRng(seed: number) {
  let s = seed
  return () => {
    s = (s * 16807 + 13) % 2147483647
    return (s - 1) / 2147483646
  }
}

// ── Chart color palette ─────────────────────────────────────
export const CHART_COLORS = [
  '#818cf8', // indigo
  '#34d399', // emerald
  '#22d3ee', // cyan
  '#f472b6', // pink
  '#fbbf24', // amber
  '#a78bfa', // violet
]

// ── Types ────────────────────────────────────────────────────
export interface UsagePoint {
  time: string
  sandboxes: number
  sessions: number
}

export interface TemplateSlice {
  name: string
  value: number
  color: string
}

export interface RegionBar {
  region: string
  label: string
  count: number
  color: string
}

export interface SparkPoint {
  value: number
}

export interface TimelinePoint {
  hour: string
  started: number
  stopped: number
  errors: number
}

// ── Generators ───────────────────────────────────────────────

export function generateUsageData(days: number): UsagePoint[] {
  const rng = createRng(days === 7 ? 101 : 202)
  const data: UsagePoint[] = []
  const points = days === 7 ? 42 : 30

  const now = new Date()

  for (let i = points; i >= 0; i--) {
    const date = new Date(now)
    if (days === 7) {
      date.setHours(date.getHours() - i * 4)
    } else {
      date.setDate(date.getDate() - i)
    }

    const hour = date.getHours()
    const dayPeak = Math.sin((hour - 5) * Math.PI / 13) * 0.35
    const base = 16 + dayPeak * 12
    const trend = ((points - i) / points) * 9
    const noise = (rng() - 0.5) * 10

    data.push({
      time:
        days === 7
          ? `${(date.getMonth() + 1)}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:00`
          : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      sandboxes: Math.round(Math.max(3, base + trend + noise)),
      sessions: Math.round(Math.max(6, (base + trend) * 2.8 + (rng() - 0.5) * 18)),
    })
  }
  return data
}

export function generateTemplateData(): TemplateSlice[] {
  return [
    { name: 'Python',  value: 342, color: CHART_COLORS[0] },
    { name: 'Node.js', value: 256, color: CHART_COLORS[1] },
    { name: 'Go',      value: 128, color: CHART_COLORS[2] },
    { name: 'Rust',    value: 89,  color: CHART_COLORS[3] },
    { name: 'Custom',  value: 45,  color: CHART_COLORS[4] },
  ]
}

export function generateRegionData(): RegionBar[] {
  return [
    { region: 'us-east-1',    label: 'US East',    count: 412, color: CHART_COLORS[0] },
    { region: 'eu-west-1',    label: 'EU West',    count: 289, color: CHART_COLORS[1] },
    { region: 'ap-south-1',   label: 'AP South',   count: 198, color: CHART_COLORS[2] },
    { region: 'us-west-2',    label: 'US West',    count: 156, color: CHART_COLORS[3] },
    { region: 'eu-central-1', label: 'EU Central', count: 134, color: CHART_COLORS[4] },
  ]
}

export function generateSparkData(
  seed: number,
  points = 24,
  trend: 'up' | 'down' | 'stable' = 'up',
): SparkPoint[] {
  const rng = createRng(seed)
  const data: SparkPoint[] = []
  let value = 35 + rng() * 25

  for (let i = 0; i < points; i++) {
    const t = trend === 'up' ? 0.7 : trend === 'down' ? -0.5 : 0
    value = Math.max(4, Math.min(96, value + t + (rng() - 0.5) * 11))
    data.push({ value: Math.round(value) })
  }
  return data
}

export function generateSessionTimeline(): TimelinePoint[] {
  const rng = createRng(303)
  const data: TimelinePoint[] = []

  for (let i = 23; i >= 0; i--) {
    const date = new Date()
    date.setHours(date.getHours() - i, 0, 0, 0)
    const peak = Math.sin((date.getHours() - 4) * Math.PI / 12)

    data.push({
      hour: date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      started: Math.round(Math.max(1, 14 + peak * 9 + (rng() - 0.5) * 7)),
      stopped: Math.round(Math.max(0, 9 + peak * 6 + (rng() - 0.5) * 5)),
      errors: Math.round(Math.max(0, rng() * 2.5 - 0.3)),
    })
  }
  return data
}

/** Demo sandboxes for the live-list when no real data exists. */
export function generateDemoSandboxes() {
  const rng = createRng(404)
  const templates = ['python', 'node', 'go', 'rust', 'python', 'node']
  const regions = ['us-east-1', 'eu-west-1', 'ap-south-1', 'us-west-2', 'eu-central-1', 'us-east-1']
  const ids = ['a8f2c1', 'b3d7e9', 'c1a4b6', 'd9e2f0', 'e5b8a3', 'f7c6d4']

  return ids.map((id, i) => ({
    id: `demo-${i}`,
    sandboxId: `sbx-${id}`,
    orgId: 'demo',
    template: templates[i],
    region: regions[i],
    workerId: `wkr-${Math.round(rng() * 99)}`,
    status: 'running' as const,
    startedAt: new Date(Date.now() - (8 + i * 18) * 60000).toISOString(),
  }))
}
