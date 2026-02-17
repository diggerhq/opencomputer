import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getOrg, updateOrg } from '../api/client'

export default function Settings() {
  const queryClient = useQueryClient()
  const { data: org, isLoading } = useQuery({
    queryKey: ['org'],
    queryFn: getOrg,
  })

  const [name, setName] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (org) setName(org.name)
  }, [org])

  const mutation = useMutation({
    mutationFn: (n: string) => updateOrg(n),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
        <div className="loading-spinner" />
      </div>
    )
  }

  const unchanged = name === org?.name

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Organization configuration</p>
      </div>

      <div className="glass-card animate-in stagger-1" style={{ padding: 28, maxWidth: 520 }}>
        {/* Org Name */}
        <div style={{ marginBottom: 22 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
            Organization Name
          </label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="input"
          />
        </div>

        {/* Plan (read-only) */}
        <div style={{ marginBottom: 22 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
            Plan
          </label>
          <div style={{
            padding: '10px 14px',
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 14,
            color: 'var(--text-tertiary)',
            textTransform: 'capitalize',
          }}>
            {org?.plan ?? 'free'}
          </div>
        </div>

        {/* Limits */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
              Max Concurrent Sandboxes
            </label>
            <div style={{
              padding: '10px 14px',
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 14,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-tertiary)',
            }}>
              {org?.maxConcurrentSandboxes}
            </div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
              Max Timeout (sec)
            </label>
            <div style={{
              padding: '10px 14px',
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 14,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-tertiary)',
            }}>
              {org?.maxSandboxTimeoutSec}
            </div>
          </div>
        </div>

        {/* Save */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button
            className="btn-primary"
            onClick={() => mutation.mutate(name)}
            disabled={mutation.isPending || unchanged}
          >
            {mutation.isPending ? 'Saving\u2026' : 'Save Changes'}
          </button>
          {saved && (
            <span style={{
              fontSize: 12, fontWeight: 500,
              color: 'var(--accent-emerald)',
              animation: 'fadeInUp 0.3s ease',
            }}>
              Saved
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
