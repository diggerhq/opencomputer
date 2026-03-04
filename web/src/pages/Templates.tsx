import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getTemplates, deleteTemplate, type Template } from '../api/client'

export default function Templates() {
  const queryClient = useQueryClient()
  const { data: templates, isLoading } = useQuery({
    queryKey: ['templates'],
    queryFn: getTemplates,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteTemplate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] })
    },
  })

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h1 className="page-title">Templates</h1>
        <p className="page-subtitle">Manage sandbox templates for your organization</p>
      </div>

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
                <th>Tag</th>
                <th>Type</th>
                <th>Status</th>
                <th>Created</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {(templates ?? []).map((t: Template) => (
                <tr key={t.id}>
                  <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{t.name}</td>
                  <td><code>{t.tag}</code></td>
                  <td>
                    <span style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: 10,
                      background: t.isPublic
                        ? 'rgba(34, 197, 94, 0.08)'
                        : 'rgba(99, 102, 241, 0.08)',
                      color: t.isPublic
                        ? 'var(--accent-green)'
                        : 'var(--accent-indigo)',
                      border: `1px solid ${t.isPublic ? 'rgba(34, 197, 94, 0.15)' : 'rgba(99, 102, 241, 0.15)'}`,
                    }}>
                      {t.isPublic ? 'Built-in' : 'Custom'}
                    </span>
                  </td>
                  <td>
                    <span style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: 10,
                      background: t.status === 'ready'
                        ? 'rgba(34, 197, 94, 0.08)'
                        : 'rgba(234, 179, 8, 0.08)',
                      color: t.status === 'ready'
                        ? 'var(--accent-green)'
                        : '#eab308',
                      border: `1px solid ${t.status === 'ready' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(234, 179, 8, 0.15)'}`,
                    }}>
                      {t.status === 'ready' ? 'Ready' : 'Processing'}
                    </span>
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                    {new Date(t.createdAt).toLocaleString()}
                  </td>
                  <td>
                    {!t.isPublic && (
                      <button
                        className="btn-danger"
                        onClick={() => {
                          if (confirm('Delete this template? Existing sandboxes using it will not be affected.')) {
                            deleteMutation.mutate(t.id)
                          }
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {(templates ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: 32, color: 'var(--text-tertiary)' }}>
                    No templates yet
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
