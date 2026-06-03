package sandbox

import (
	"fmt"
	"io"
	"os/exec"
	"sync"

	"github.com/google/uuid"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// PTYManager manages PTY sessions via Firecracker agent gRPC.
type PTYManager struct {
	mu       sync.RWMutex
	sessions map[string]*PTYSessionHandle

	// createFunc creates PTY sessions via the Firecracker agent.
	createFunc func(sandboxID string, req types.PTYCreateRequest) (*PTYSessionHandle, error)

	// rebindFunc binds a NEW gRPC PTYAttach stream to an EXISTING agent-side
	// session by ID. Used after live migration (or worker restart): the in-VM
	// agent retains the PTY/shell across the move, but the destination worker's
	// in-process session map is empty. Falling back to rebind on cache miss
	// makes session_id portable across workers without touching the agent.
	rebindFunc func(sandboxID, sessionID string) (*PTYSessionHandle, error)
}

// PTYSessionHandle holds the state for an active PTY session.
type PTYSessionHandle struct {
	ID        string
	SandboxID string
	Cmd       *exec.Cmd          // unused (kept for interface compat), nil for Firecracker
	PTY       io.ReadWriteCloser // PTY I/O stream (net.Conn for Firecracker)
	Done      chan struct{}

	// onKill is called when the session is killed (sends gRPC PTYKill).
	onKill func()
	// onResize is called when the session is resized (sends gRPC PTYResize).
	onResize func(cols, rows int) error
}

// NewAgentPTYManager creates a PTY manager that delegates session creation
// to createFunc (gRPC PTYCreate against the in-VM agent) and session
// recovery to rebindFunc (gRPC PTYAttach against an existing in-VM session).
// rebindFunc may be nil — RebindFromAgent then always reports "not found",
// so the manager behaves as a strict local cache with no agent fallback.
func NewAgentPTYManager(
	createFunc func(sandboxID string, req types.PTYCreateRequest) (*PTYSessionHandle, error),
	rebindFunc func(sandboxID, sessionID string) (*PTYSessionHandle, error),
) *PTYManager {
	return &PTYManager{
		sessions:   make(map[string]*PTYSessionHandle),
		createFunc: createFunc,
		rebindFunc: rebindFunc,
	}
}

// RebindFromAgent attempts to look up sessionID against the in-VM agent and,
// if it's still alive, register a fresh local handle that streams through a
// new PTYAttach. Used after live migration or worker restart wipes the local
// session map. Returns the registered handle on success, or an error if the
// agent reports the session is gone (or if rebindFunc was not configured).
func (pm *PTYManager) RebindFromAgent(sandboxID, sessionID string) (*PTYSessionHandle, error) {
	if pm.rebindFunc == nil {
		return nil, fmt.Errorf("PTY session %s not found", sessionID)
	}
	// Drop any stale local entry first — its underlying gRPC stream points at
	// the old worker's agent connection and won't ever produce bytes again.
	pm.mu.Lock()
	if stale, ok := pm.sessions[sessionID]; ok {
		delete(pm.sessions, sessionID)
		_ = stale.PTY.Close()
	}
	pm.mu.Unlock()

	handle, err := pm.rebindFunc(sandboxID, sessionID)
	if err != nil {
		return nil, err
	}
	pm.mu.Lock()
	pm.sessions[handle.ID] = handle
	pm.mu.Unlock()
	return handle, nil
}

// CreateSession starts a new PTY session inside a sandbox.
func (pm *PTYManager) CreateSession(sandboxID string, req types.PTYCreateRequest) (*PTYSessionHandle, error) {
	if pm.createFunc == nil {
		return nil, fmt.Errorf("no PTY create function configured")
	}

	handle, err := pm.createFunc(sandboxID, req)
	if err != nil {
		return nil, err
	}

	// Assign a session ID if one wasn't set by the create function
	if handle.ID == "" {
		handle.ID = uuid.New().String()[:8]
	}

	pm.mu.Lock()
	pm.sessions[handle.ID] = handle
	pm.mu.Unlock()
	return handle, nil
}

// Resize changes the terminal size for a PTY session.
func (pm *PTYManager) Resize(sessionID string, cols, rows int) error {
	pm.mu.RLock()
	session, ok := pm.sessions[sessionID]
	pm.mu.RUnlock()

	if !ok {
		return fmt.Errorf("PTY session %s not found", sessionID)
	}

	if session.onResize != nil {
		return session.onResize(cols, rows)
	}

	return fmt.Errorf("resize not supported for this session type")
}

// GetSession returns a PTY session by ID.
func (pm *PTYManager) GetSession(sessionID string) (*PTYSessionHandle, error) {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	session, ok := pm.sessions[sessionID]
	if !ok {
		return nil, fmt.Errorf("PTY session %s not found", sessionID)
	}
	return session, nil
}

// KillSession terminates a PTY session.
func (pm *PTYManager) KillSession(sessionID string) error {
	pm.mu.Lock()
	session, ok := pm.sessions[sessionID]
	if ok {
		delete(pm.sessions, sessionID)
	}
	pm.mu.Unlock()

	if !ok {
		return fmt.Errorf("PTY session %s not found", sessionID)
	}

	if session.onKill != nil {
		session.onKill()
	}

	session.PTY.Close()
	if session.Cmd != nil && session.Cmd.Process != nil {
		_ = session.Cmd.Process.Kill()
	}
	return nil
}

// ReleaseForSandbox drops every local session belonging to sandboxID and
// closes its underlying gRPC PTY stream so any in-flight WS handler blocked
// on session.PTY.Read() unblocks immediately. Does NOT invoke onKill — the
// in-VM PTY is owned by the agent and may have migrated to another worker
// that's still serving it. Use this on the SOURCE side of a live migration
// (or after DestroySandbox) so the edge DO sees the upstream close, redials,
// and lands on the destination worker where RebindFromAgent can take over.
func (pm *PTYManager) ReleaseForSandbox(sandboxID string) {
	pm.mu.Lock()
	var toRelease []*PTYSessionHandle
	for id, s := range pm.sessions {
		if s.SandboxID == sandboxID {
			toRelease = append(toRelease, s)
			delete(pm.sessions, id)
		}
	}
	pm.mu.Unlock()
	for _, s := range toRelease {
		_ = s.PTY.Close()
	}
}

// CloseAll terminates all PTY sessions.
func (pm *PTYManager) CloseAll() {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	for _, session := range pm.sessions {
		if session.onKill != nil {
			session.onKill()
		}
		session.PTY.Close()
		if session.Cmd != nil && session.Cmd.Process != nil {
			_ = session.Cmd.Process.Kill()
		}
	}
	pm.sessions = make(map[string]*PTYSessionHandle)
}
