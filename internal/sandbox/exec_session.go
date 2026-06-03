package sandbox

import (
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/opensandbox/opensandbox/pkg/types"
)

// ExecSessionManager manages exec sessions on the host side.
type ExecSessionManager struct {
	mu         sync.RWMutex
	sessions   map[string]*ExecSessionHandle
	createFunc func(sandboxID string, req types.ExecSessionCreateRequest) (*ExecSessionHandle, error)
	// rebindFunc binds a NEW gRPC ExecSessionAttach stream to an EXISTING
	// agent-side session by ID. Used after live migration (or worker restart)
	// makes the local session map empty while the in-VM session keeps running.
	rebindFunc func(sandboxID, sessionID string) (*ExecSessionHandle, error)
}

// ExecSessionHandle holds the state for an exec session on the host side.
type ExecSessionHandle struct {
	ID          string
	SandboxID   string
	Command     string
	Args        []string
	Running     bool
	ExitCode    *int
	StartedAt   time.Time
	Done        chan struct{}
	Scrollback  *ScrollbackBuffer
	StdinWriter io.Writer

	OnKill func(signal int) error
}

// NewExecSessionManager creates a stub exec session manager (Podman — not supported).
func NewExecSessionManager() *ExecSessionManager {
	return &ExecSessionManager{
		sessions: make(map[string]*ExecSessionHandle),
	}
}

// NewAgentExecSessionManager creates an exec session manager that delegates
// session creation to createFunc (gRPC ExecSessionCreate) and recovery to
// rebindFunc (gRPC ExecSessionAttach against an existing in-VM session).
// rebindFunc may be nil — RebindFromAgent then always reports "not found".
func NewAgentExecSessionManager(
	createFunc func(sandboxID string, req types.ExecSessionCreateRequest) (*ExecSessionHandle, error),
	rebindFunc func(sandboxID, sessionID string) (*ExecSessionHandle, error),
) *ExecSessionManager {
	return &ExecSessionManager{
		sessions:   make(map[string]*ExecSessionHandle),
		createFunc: createFunc,
		rebindFunc: rebindFunc,
	}
}

// RebindFromAgent attempts to look up sessionID against the in-VM agent and,
// if it's still alive, register a fresh local handle that streams through a
// new ExecSessionAttach. Used after live migration or worker restart wipes
// the local session map. Returns the registered handle on success, or an
// error if the agent reports the session is gone.
func (m *ExecSessionManager) RebindFromAgent(sandboxID, sessionID string) (*ExecSessionHandle, error) {
	if m.rebindFunc == nil {
		return nil, fmt.Errorf("exec session %s not found", sessionID)
	}
	// Drop stale local entry first — its gRPC stream targets the old worker.
	m.mu.Lock()
	if stale, ok := m.sessions[sessionID]; ok {
		delete(m.sessions, sessionID)
		if stale.OnKill != nil {
			// Don't actually kill — just release local pipes. The agent owns
			// the process and we want it to keep running.
			_ = stale
		}
	}
	m.mu.Unlock()

	handle, err := m.rebindFunc(sandboxID, sessionID)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.sessions[handle.ID] = handle
	m.mu.Unlock()
	return handle, nil
}

// CreateSession creates a new exec session.
func (m *ExecSessionManager) CreateSession(sandboxID string, req types.ExecSessionCreateRequest) (*ExecSessionHandle, error) {
	if m.createFunc == nil {
		return nil, fmt.Errorf("exec sessions not supported in Podman mode")
	}

	handle, err := m.createFunc(sandboxID, req)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	m.sessions[handle.ID] = handle
	m.mu.Unlock()

	return handle, nil
}

// GetSession returns an exec session by ID.
func (m *ExecSessionManager) GetSession(sessionID string) (*ExecSessionHandle, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	session, ok := m.sessions[sessionID]
	if !ok {
		return nil, fmt.Errorf("exec session %s not found", sessionID)
	}
	return session, nil
}

// ListSessions returns info for all sessions belonging to a sandbox.
func (m *ExecSessionManager) ListSessions(sandboxID string) []types.ExecSessionInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var results []types.ExecSessionInfo
	for _, s := range m.sessions {
		if s.SandboxID == sandboxID {
			info := types.ExecSessionInfo{
				SessionID: s.ID,
				SandboxID: s.SandboxID,
				Command:   s.Command,
				Args:      s.Args,
				Running:   s.Running,
				ExitCode:  s.ExitCode,
				StartedAt: s.StartedAt.Format(time.RFC3339),
			}
			results = append(results, info)
		}
	}
	return results
}

// KillSession kills an exec session with the given signal.
func (m *ExecSessionManager) KillSession(sessionID string, signal int) error {
	m.mu.RLock()
	session, ok := m.sessions[sessionID]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("exec session %s not found", sessionID)
	}

	if session.OnKill != nil {
		return session.OnKill(signal)
	}
	return fmt.Errorf("kill not supported for this session")
}

// CloseAll terminates all exec sessions.
func (m *ExecSessionManager) CloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, session := range m.sessions {
		if session.OnKill != nil {
			_ = session.OnKill(9) // SIGKILL
		}
	}
	m.sessions = make(map[string]*ExecSessionHandle)
}

// RemoveSessions removes all sessions for a sandbox (used on hibernate/kill).
func (m *ExecSessionManager) RemoveSessions(sandboxID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	for id, s := range m.sessions {
		if s.SandboxID == sandboxID {
			delete(m.sessions, id)
		}
	}
}
