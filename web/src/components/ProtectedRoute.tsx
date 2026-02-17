import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

export default function ProtectedRoute() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        gap: 16,
        background: 'var(--bg-void)',
      }}>
        <div className="loading-spinner" />
        <span style={{
          fontSize: 12,
          color: 'var(--text-tertiary)',
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.04em',
        }}>
          Loading&hellip;
        </span>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  return <Outlet />
}
