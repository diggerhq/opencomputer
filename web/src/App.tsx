import { lazy } from 'react'
import { Routes, Route, Navigate, useParams } from 'react-router-dom'
import { AuthProvider } from './hooks/auth-provider'
import ProtectedRoute from './components/ProtectedRoute'
import AppShell from './components/app-shell'

// Route pages are code-split so the initial bundle stays small; the heaviest
// deps (xterm, in Terminal/LogsPanel) only load on SandboxDetail when opened.
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Sandboxes = lazy(() => import('./pages/Sandboxes'))
const APIKeys = lazy(() => import('./pages/APIKeys'))
const Checkpoints = lazy(() => import('./pages/Checkpoints'))
const Templates = lazy(() => import('./pages/Templates'))
const Settings = lazy(() => import('./pages/Settings'))
const Billing = lazy(() => import('./pages/Billing'))
const SandboxDetail = lazy(() => import('./pages/SandboxDetail'))

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route index element={<Dashboard />} />
            <Route path="sandboxes" element={<Sandboxes />} />
            <Route path="sandboxes/:sandboxId" element={<SandboxDetail />} />
            {/* Back-compat: the tab was renamed Sandboxes → Sandboxes. Keep the
                old deep links working, including /sessions/:sandboxId. */}
            <Route
              path="sessions"
              element={<Navigate to="/sandboxes" replace />}
            />
            <Route
              path="sessions/:sandboxId"
              element={<LegacySandboxRedirect />}
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

// Preserves the :sandboxId when redirecting the old /sessions/:id deep link.
function LegacySandboxRedirect() {
  const { sandboxId } = useParams()
  return <Navigate to={`/sandboxes/${sandboxId ?? ''}`} replace />
}
