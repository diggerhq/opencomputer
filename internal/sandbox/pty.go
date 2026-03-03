package sandbox

import (
	"fmt"
	"io"
	"sync"

	"github.com/opensandbox/opensandbox/pkg/types"
)

// PTYManager manages PTY sessions via a pluggable create function
// (Firecracker agent gRPC + vsock data port).
type PTYManager struct {
	mu       sync.RWMutex
	sessions map[string]*PTYSessionHandle

	// createFunc creates a new PTY session for a sandbox.
	createFunc func(sandboxID string, req types.PTYCreateRequest) (*PTYSessionHandle, error)
}

// PTYSessionHandle holds the state for an active PTY session.
type PTYSessionHandle struct {
	ID        string
	SandboxID string
	PTY       io.ReadWriteCloser // PTY I/O stream (net.Conn for Firecracker vsock)
	Done      chan struct{}

	// onKill is called when the session is killed (sends gRPC PTYKill).
	onKill func()
	// onResize is called when the session is resized (sends gRPC PTYResize).
	onResize func(cols, rows int) error
}

// NewAgentPTYManager creates a PTY manager that delegates to a custom
// create function (used by Firecracker mode).
func NewAgentPTYManager(createFunc func(sandboxID string, req types.PTYCreateRequest) (*PTYSessionHandle, error)) *PTYManager {
	return &PTYManager{
		sessions:   make(map[string]*PTYSessionHandle),
		createFunc: createFunc,
	}
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
	return nil
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
	}
	pm.sessions = make(map[string]*PTYSessionHandle)
}
