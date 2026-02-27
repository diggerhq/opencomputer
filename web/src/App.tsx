import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './hooks/useAuth'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Sessions from './pages/Sessions'
import APIKeys from './pages/APIKeys'
import Templates from './pages/Templates'
import Settings from './pages/Settings'
import SessionDetail from './pages/SessionDetail'
import Secrets from './pages/Secrets'

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="sessions" element={<Sessions />} />
            <Route path="sessions/:sandboxId" element={<SessionDetail />} />
            <Route path="templates" element={<Templates />} />
            <Route path="secrets" element={<Secrets />} />
            <Route path="api-keys" element={<APIKeys />} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  )
}
