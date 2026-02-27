import { useState, useEffect } from 'react'
import {
  getSecrets, createSecret, updateSecret, deleteSecret,
  getSecretGroups, createSecretGroup, updateSecretGroup, deleteSecretGroup, getSecretGroup,
  Secret, SecretGroup, SecretGroupDetail,
} from '../api/client'

/* ── helpers ──────────────────────────────────────────────── */
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/* ── Modal ───────────────────────────────────────────────── */
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
        borderRadius: 12, padding: 28, width: 520, maxWidth: '90vw',
        boxShadow: '0 24px 48px rgba(0,0,0,0.4)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 7,
  border: '1px solid var(--border-subtle)', background: 'var(--bg-deep)',
  color: 'var(--text-primary)', fontSize: 13, fontFamily: 'var(--font-body)',
  boxSizing: 'border-box',
}
const btnPrimary: React.CSSProperties = {
  padding: '9px 18px', borderRadius: 7, border: 'none', cursor: 'pointer',
  background: 'var(--accent-indigo)', color: '#fff', fontSize: 13, fontWeight: 600,
}
const btnDanger: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 6, border: '1px solid var(--accent-rose)',
  background: 'transparent', color: 'var(--accent-rose)', fontSize: 12, cursor: 'pointer',
}

/* ── Secrets panel ───────────────────────────────────────── */
function SecretsPanel({ secrets, onRefresh }: { secrets: Secret[]; onRefresh: () => void }) {
  const [showAdd, setShowAdd] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleCreate() {
    if (!name || !value) { setError('Name and value are required'); return }
    setSaving(true); setError('')
    try {
      await createSecret(name, description, value)
      setShowAdd(false); setName(''); setDescription(''); setValue('')
      onRefresh()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this secret? Any groups using it will lose access.')) return
    try { await deleteSecret(id); onRefresh() } catch {}
  }

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Secrets Vault</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>Encrypted at rest — values shown only once</div>
        </div>
        <button style={btnPrimary} onClick={() => setShowAdd(true)}>+ Add Secret</button>
      </div>

      {secrets.length === 0 ? (
        <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
          No secrets yet. Add your first secret to get started.
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-deep)' }}>
                {['Name', 'Description', 'Created', ''].map(h => (
                  <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-subtle)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {secrets.map((s, i) => (
                <tr key={s.id} style={{ borderBottom: i < secrets.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
                  <td style={{ padding: '10px 14px', fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{s.name}</td>
                  <td style={{ padding: '10px 14px', fontSize: 13, color: 'var(--text-secondary)' }}>{s.description || '—'}</td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-tertiary)' }}>{formatDate(s.createdAt)}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                    <button style={btnDanger} onClick={() => handleDelete(s.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <Modal title="Add Secret" onClose={() => { setShowAdd(false); setError('') }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Name</label>
              <input style={inputStyle} placeholder="e.g. ANTHROPIC_API_KEY" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Description (optional)</label>
              <input style={inputStyle} placeholder="What is this key for?" value={description} onChange={e => setDescription(e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Value</label>
              <input style={inputStyle} type="password" placeholder="sk-ant-api03-..." value={value} onChange={e => setValue(e.target.value)} />
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>Value is encrypted and cannot be retrieved after saving.</div>
            </div>
            {error && <div style={{ fontSize: 12, color: 'var(--accent-rose)' }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button style={{ ...btnPrimary, background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }} onClick={() => { setShowAdd(false); setError('') }}>Cancel</button>
              <button style={btnPrimary} onClick={handleCreate} disabled={saving}>{saving ? 'Saving…' : 'Save Secret'}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

/* ── Secret Groups panel ──────────────────────────────────── */
function SecretGroupsPanel({ groups, secrets, onRefresh }: { groups: SecretGroup[]; secrets: Secret[]; onRefresh: () => void }) {
  const [selected, setSelected] = useState<SecretGroupDetail | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [allowedHosts, setAllowedHosts] = useState('')
  const [entries, setEntries] = useState<Array<{ secretId: string; envVarName: string }>>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function loadGroup(id: string) {
    try { setSelected(await getSecretGroup(id)) } catch {}
  }

  async function handleCreate() {
    if (!name) { setError('Name is required'); return }
    setSaving(true); setError('')
    try {
      const hosts = allowedHosts.split(',').map(h => h.trim()).filter(Boolean)
      await createSecretGroup(name, description, hosts, entries)
      setShowNew(false); resetForm(); onRefresh()
    } catch (e: any) {
      setError(e.message)
    } finally { setSaving(false) }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this secret group?')) return
    try { await deleteSecretGroup(id); if (selected?.id === id) setSelected(null); onRefresh() } catch {}
  }

  function resetForm() { setName(''); setDescription(''); setAllowedHosts(''); setEntries([]) }

  function addEntry() { setEntries(prev => [...prev, { secretId: '', envVarName: '' }]) }
  function updateEntry(i: number, field: 'secretId' | 'envVarName', val: string) {
    setEntries(prev => prev.map((e, idx) => idx === i ? { ...e, [field]: val } : e))
  }
  function removeEntry(i: number) { setEntries(prev => prev.filter((_, idx) => idx !== i)) }

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Secret Groups</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>Attach groups to sandboxes via <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>secretGroupId</code></div>
        </div>
        <button style={btnPrimary} onClick={() => { setShowNew(true); resetForm() }}>+ New Group</button>
      </div>

      {groups.length === 0 ? (
        <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
          No secret groups yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {groups.map(g => (
            <div key={g.id} style={{
              border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 16px',
              cursor: 'pointer', background: selected?.id === g.id ? 'rgba(99,102,241,0.06)' : 'var(--bg-card)',
            }} onClick={() => loadGroup(g.id)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{g.name}</span>
                  {g.description && <span style={{ fontSize: 12, color: 'var(--text-tertiary)', marginLeft: 8 }}>{g.description}</span>}
                </div>
                <button style={btnDanger} onClick={e => { e.stopPropagation(); handleDelete(g.id) }}>Delete</button>
              </div>
              {selected?.id === g.id && selected.entries && selected.entries.length > 0 && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {selected.entries.map(e => (
                    <div key={e.id} style={{ display: 'flex', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                      <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-indigo)' }}>{e.envVarName}</code>
                      <span style={{ color: 'var(--text-tertiary)' }}>→</span>
                      <span>{e.secretName}</span>
                    </div>
                  ))}
                  {selected.allowedHosts && selected.allowedHosts.length > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                      Egress: {selected.allowedHosts.join(', ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showNew && (
        <Modal title="New Secret Group" onClose={() => { setShowNew(false); setError('') }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Name</label>
              <input style={inputStyle} placeholder="e.g. anthropic-keys" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Description (optional)</label>
              <input style={inputStyle} value={description} onChange={e => setDescription(e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Allowed Hosts (optional, comma-separated)</label>
              <input style={inputStyle} placeholder="api.anthropic.com, *.openai.com" value={allowedHosts} onChange={e => setAllowedHosts(e.target.value)} />
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3 }}>Leave empty to allow all outbound HTTPS.</div>
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Entries</label>
                <button onClick={addEntry} style={{ fontSize: 11, background: 'none', border: 'none', color: 'var(--accent-indigo)', cursor: 'pointer' }}>+ Add entry</button>
              </div>
              {entries.map((e, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                  <input style={{ ...inputStyle, flex: 1 }} placeholder="ENV_VAR_NAME" value={e.envVarName} onChange={ev => updateEntry(i, 'envVarName', ev.target.value)} />
                  <select style={{ ...inputStyle, flex: 1 }} value={e.secretId} onChange={ev => updateEntry(i, 'secretId', ev.target.value)}>
                    <option value="">Select secret…</option>
                    {secrets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <button onClick={() => removeEntry(i)} style={{ background: 'none', border: 'none', color: 'var(--accent-rose)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
                </div>
              ))}
            </div>
            {error && <div style={{ fontSize: 12, color: 'var(--accent-rose)' }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button style={{ ...btnPrimary, background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }} onClick={() => { setShowNew(false); setError('') }}>Cancel</button>
              <button style={btnPrimary} onClick={handleCreate} disabled={saving}>{saving ? 'Saving…' : 'Create Group'}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

/* ── Page ─────────────────────────────────────────────────── */
export default function Secrets() {
  const [secrets, setSecrets] = useState<Secret[]>([])
  const [groups, setGroups] = useState<SecretGroup[]>([])
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    try {
      const [s, g] = await Promise.all([getSecrets(), getSecretGroups()])
      setSecrets(s)
      setGroups(g)
    } catch {}
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  if (loading) {
    return <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: 40 }}>Loading…</div>
  }

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-display)', letterSpacing: '-0.02em', margin: 0 }}>Secrets</h1>
        <p style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 6, marginBottom: 0 }}>
          Store API keys and credentials securely. Sandboxes receive opaque sealed tokens — real values never enter the VM.
        </p>
      </div>
      <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start' }}>
        <SecretsPanel secrets={secrets} onRefresh={load} />
        <div style={{ width: 1, background: 'var(--border-subtle)', alignSelf: 'stretch' }} />
        <SecretGroupsPanel groups={groups} secrets={secrets} onRefresh={load} />
      </div>
    </div>
  )
}
