import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './hooks/auth-provider'
import ProtectedRoute from './components/ProtectedRoute'
import AppShell from './components/app-shell'
import Dashboard from './pages/Dashboard'
import Sessions from './pages/Sessions'
import APIKeys from './pages/APIKeys'
import Checkpoints from './pages/Checkpoints'
import Templates from './pages/Templates'
import Settings from './pages/Settings'
import Billing from './pages/Billing'
import SessionDetail from './pages/SessionDetail'

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route index element={<Dashboard />} />
            <Route path="sandboxes" element={<Sessions />} />
            <Route path="sandboxes/:sandboxId" element={<SessionDetail />} />
            {/* Back-compat: the tab was renamed Sessions → Sandboxes. */}
            <Route
              path="sessions"
              element={<Navigate to="/sandboxes" replace />}
            />
            <Route path="checkpoints" element={<Checkpoints />} />
            <Route path="templates" element={<Templates />} />
            <Route path="api-keys" element={<APIKeys />} />
            <Route path="billing" element={<Billing />} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  )
}
