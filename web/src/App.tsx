import { lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './hooks/auth-provider'
import ProtectedRoute from './components/ProtectedRoute'
import AppShell from './components/app-shell'

// Route pages are code-split so the initial bundle stays small; the heaviest
// deps (xterm, in Terminal/LogsPanel) only load on SessionDetail when opened.
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Sessions = lazy(() => import('./pages/Sessions'))
const APIKeys = lazy(() => import('./pages/APIKeys'))
const Checkpoints = lazy(() => import('./pages/Checkpoints'))
const Templates = lazy(() => import('./pages/Templates'))
const Settings = lazy(() => import('./pages/Settings'))
const Billing = lazy(() => import('./pages/Billing'))
const SessionDetail = lazy(() => import('./pages/SessionDetail'))

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
