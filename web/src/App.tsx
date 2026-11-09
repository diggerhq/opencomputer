import { lazy } from 'react'
import { Routes, Route, Navigate, useSearchParams } from 'react-router-dom'
import { AuthProvider } from './hooks/auth-provider'
import ProtectedRoute from './components/ProtectedRoute'
import AppShell from './components/app-shell'
import PublicTemplateRoute from './components/PublicTemplateRoute'
import { managedAgentsExperimentEnabled } from './managed-agents/feature'
import { templateDeployPathFromSearch } from './managed-agents/templates'

// Route pages are code-split so the initial bundle stays small.
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Browsers = lazy(() => import('./pages/Browsers'))
const APIKeys = lazy(() => import('./pages/APIKeys'))
const Settings = lazy(() => import('./pages/Settings'))
const Billing = lazy(() => import('./pages/Billing'))
const DeferredAction = lazy(() => import('./pages/DeferredAction'))
const ManagedAgentsHome = lazy(() => import('./managed-agents/Home'))
const ManagedComputer = lazy(() => import('./managed-agents/Computer'))
const ManagedComputerSecrets = lazy(
  () => import('./managed-agents/ComputerSecrets'),
)
const ManagedAgentDetail = lazy(() => import('./managed-agents/Detail'))
const ManagedProjectDetail = lazy(() => import('./managed-agents/Project'))
const ManagedSessionDetail = lazy(() => import('./managed-agents/Session'))
const ManagedAgentConnections = lazy(
  () => import('./managed-agents/Connections'),
)
const ManagedProjectOnboarding = lazy(
  () => import('./managed-agents/ProjectOnboarding'),
)
const ManagedTemplateNew = lazy(() => import('./managed-agents/TemplateNew'))
const ManagedSecurityOnboarding = lazy(
  () => import('./managed-agents/security/SecurityOnboarding'),
)
const ManagedProjectSwarm = lazy(
  () => import('./managed-agents/security/ProjectSwarm'),
)
const ManagedProjectSwarms = lazy(
  () => import('./managed-agents/security/ProjectSwarms'),
)
const ModelAccessCallback = lazy(
  () => import('./managed-agents/ModelAccessCallback'),
)

function NewProject() {
  const [searchParams] = useSearchParams()
  const templatePath = templateDeployPathFromSearch(searchParams)
  if (templatePath) return <Navigate to={templatePath} replace />
  return <ManagedProjectOnboarding />
}

// `app.opencomputer.dev/?security=1` drops into the independent CVE Swarm
// onboarding path; the param survives the login round-trip via returnTo.
function HomeRoute() {
  const [searchParams] = useSearchParams()
  if (searchParams.get('security') === '1')
    return <Navigate to="/security" replace />
  return managedAgentsExperimentEnabled ? <ManagedAgentsHome /> : <Dashboard />
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Deferred-action executor — outside ProtectedRoute so the anonymous
            branch can fire analytics + capture returnTo before login. */}
        <Route path="do" element={<DeferredAction />} />
        {/* Template links are shareable: anonymous visitors see the template
            and its deploy form, and sign up when they actually deploy. */}
        <Route element={<PublicTemplateRoute />}>
          <Route path="template" element={<ManagedTemplateNew />} />
        </Route>
        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route index element={<HomeRoute />} />
            <Route path="security" element={<ManagedSecurityOnboarding />} />
            <Route
              path="getting-started"
              element={
                managedAgentsExperimentEnabled ? (
                  <ManagedAgentsHome />
                ) : (
                  <Dashboard />
                )
              }
            />
            <Route path="computer" element={<ManagedComputer />} />
            <Route
              path="computer/secrets"
              element={<ManagedComputerSecrets />}
            />
            {managedAgentsExperimentEnabled ? (
              <Route path="automations" element={<ManagedAgentsHome list />} />
            ) : null}
            <Route
              path="model-access/callback"
              element={<ModelAccessCallback />}
            />
            <Route
              path="managed-agents/connections"
              element={<ManagedAgentConnections />}
            />
            <Route
              path="managed-agents/new"
              element={<Navigate to="/new" replace />}
            />
            <Route path="new" element={<NewProject />} />
            <Route
              path="projects/:projectId"
              element={<ManagedProjectDetail />}
            />
            <Route
              path="projects/:projectId/playground/:projectAgentId"
              element={<ManagedProjectDetail />}
            />
            <Route
              path="projects/:projectId/sessions/:sessionId"
              element={<ManagedSessionDetail />}
            />
            <Route
              path="projects/:projectId/swarm"
              element={<Navigate to="../swarms" replace />}
            />
            <Route
              path="projects/:projectId/swarms"
              element={<ManagedProjectSwarms />}
            />
            <Route
              path="projects/:projectId/:tab"
              element={<ManagedProjectDetail />}
            />
            <Route
              path="managed-agents/:agentId"
              element={<ManagedAgentDetail />}
            />
            <Route path="browsers" element={<Browsers />} />
            <Route path="api-keys" element={<APIKeys />} />
            <Route path="billing" element={<Billing />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          {/* A swarm run is its own full-screen view: no app-shell sidebar, so
              the mission-control map and report get the whole width. */}
          <Route
            path="projects/:projectId/swarms/:runId"
            element={<ManagedProjectSwarm />}
          />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  )
}
