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
	ExitedAt    time.Time // zero until the command exits; for command_ms timing
	Done        chan struct{}
	Scrollback  *ScrollbackBuffer
	StdinWriter io.Writer

	OnKill func(signal int) error

	// Cancel terminates the gRPC ExecSessionAttach stream this handle is
	// driven by, without signaling the in-VM session to exit. Called by
	// ReleaseForSandbox on the source side of a live migration so the
	// worker's WS handler unblocks immediately and the edge DO sees an
	// upstream close (→ redial → destination rebind). Nil-safe.
	Cancel func()
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
	// Defensive: drop any stale local entry — after a normal migration the
	// source worker's onMigrationOutgoing hook has already released this
	// sandbox's sessions, so the map should be empty here. If it isn't, the
	// fresh handle we install below supersedes the stale one; we don't try
	// to actively reclaim the old gRPC stream because its context is owned
	// by a goroutine we don't have a handle to from here.
	m.mu.Lock()
	delete(m.sessions, sessionID)
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

// GetResult returns the current result of an exec session from its local
// handle — the scrollback (split by stream) plus the exit code captured by the
// worker's attach stream. This is the load-bearing call behind the async
// exec/run poll endpoint. If the local map missed (live migration or worker
// restart moved the still-alive in-VM session), it rebinds from the agent
// first, reusing the same recovery path as the WS attach handler.
//
// Running is derived from the captured exit code rather than the handle's
// Running flag: consumeExecOutput sets ExitCode before clearing Running, so
// gating on ExitCode==nil never reports a finished command without its code.
func (m *ExecSessionManager) GetResult(sandboxID, sessionID string) (*types.ExecSessionResult, error) {
	m.mu.RLock()
	sess, ok := m.sessions[sessionID]
	m.mu.RUnlock()
	if !ok {
		var err error
		sess, err = m.RebindFromAgent(sandboxID, sessionID)
		if err != nil {
			return nil, fmt.Errorf("exec session %s not found", sessionID)
		}
	}

	res := &types.ExecSessionResult{Running: sess.ExitCode == nil}
	if sess.ExitCode != nil {
		ec := *sess.ExitCode
		res.ExitCode = &ec
	}
	// command_ms: wall-clock of the command itself (start → exit, or → now if
	// still running). Feeds the 524 attribution (command duration vs wake).
	if !sess.StartedAt.IsZero() {
		end := sess.ExitedAt
		if end.IsZero() {
			end = time.Now()
		}
		res.CommandMs = end.Sub(sess.StartedAt).Milliseconds()
	}
	if sess.Scrollback != nil {
		for _, ch := range sess.Scrollback.Snapshot() {
			if ch.Stream == 2 {
				res.Stderr = append(res.Stderr, ch.Data...)
			} else {
				res.Stdout = append(res.Stdout, ch.Data...)
			}
		}
		res.Truncated = sess.Scrollback.Truncated()
	}
	return res, nil
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

// ReleaseForSandbox drops every local exec session for sandboxID and cancels
// its gRPC ExecSessionAttach stream so the worker's WS handler — blocked on
// the scrollback subscription — unblocks via session.Done. Does NOT invoke
// OnKill (which would tell the in-VM agent to terminate the process); the
// session is alive on another worker post-migration.
//
// Counterpart to PTYManager.ReleaseForSandbox; same role for the source side
// of a live migration.
func (m *ExecSessionManager) ReleaseForSandbox(sandboxID string) {
	m.mu.Lock()
	var toRelease []*ExecSessionHandle
	for id, s := range m.sessions {
		if s.SandboxID == sandboxID {
			toRelease = append(toRelease, s)
			delete(m.sessions, id)
		}
	}
	m.mu.Unlock()
	for _, s := range toRelease {
		if s.Cancel != nil {
			s.Cancel()
		}
	}
}
