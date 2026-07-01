import { lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './hooks/auth-provider'
import ProtectedRoute from './components/ProtectedRoute'
import AppShell from './components/app-shell'

// Route pages are code-split so the initial bundle stays small; the heaviest
// deps (xterm, in Terminal/LogsPanel) only load on SandboxDetail when opened.
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Agents = lazy(() => import('./pages/Agents'))
const AgentDetail = lazy(() => import('./pages/AgentDetail'))
const Credentials = lazy(() => import('./pages/Credentials'))
const Sessions = lazy(() => import('./pages/Sessions'))
const SessionDetail = lazy(() => import('./pages/SessionDetail'))
const Browsers = lazy(() => import('./pages/Browsers'))
const Sandboxes = lazy(() => import('./pages/Sandboxes'))
const APIKeys = lazy(() => import('./pages/APIKeys'))
const Checkpoints = lazy(() => import('./pages/Checkpoints'))
const Templates = lazy(() => import('./pages/Templates'))
const Settings = lazy(() => import('./pages/Settings'))
const Billing = lazy(() => import('./pages/Billing'))
const SandboxDetail = lazy(() => import('./pages/SandboxDetail'))
const SandboxWebhooks = lazy(() => import('./pages/SandboxWebhooks'))

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route index element={<Dashboard />} />
            {/* Agent plane */}
            <Route path="agents" element={<Agents />} />
            <Route path="agents/:agentId" element={<AgentDetail />} />
            <Route path="agents/:agentId/:tab" element={<AgentDetail />} />
            <Route path="credentials" element={<Credentials />} />
            <Route path="sessions" element={<Sessions />} />
            <Route path="sessions/:sessionId" element={<SessionDetail />} />
            <Route path="browsers" element={<Browsers />} />
            {/* Sandbox plane */}
            <Route path="sandboxes" element={<Sandboxes />} />
            <Route path="sandboxes/:sandboxId" element={<SandboxDetail />} />
            <Route path="checkpoints" element={<Checkpoints />} />
            <Route path="templates" element={<Templates />} />
            <Route path="sandbox-webhooks" element={<SandboxWebhooks />} />
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
