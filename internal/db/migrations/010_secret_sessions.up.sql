-- Store secret session credentials on sandbox_sessions so wake-on-request
-- can pass them to the worker for ResolveSecretSession.
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS secret_session_id TEXT;
ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS secret_session_token TEXT;
