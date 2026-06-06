package sandbox

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const sqliteSchema = `
CREATE TABLE IF NOT EXISTS command_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command TEXT NOT NULL,
    args TEXT,
    cwd TEXT,
    exit_code INTEGER,
    duration_ms INTEGER,
    stdout_len INTEGER,
    stderr_len INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pty_sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    bytes_in INTEGER DEFAULT 0,
    bytes_out INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload TEXT,
    synced INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_unsynced ON events(synced) WHERE synced = 0;

-- Generation stamp embedded in upstream envelope IDs so post-wake events
-- (where AUTOINCREMENT restarts after the DB file is recreated) do not
-- collide with pre-hibernate IDs and get silently dropped by events-ingest's
-- ON CONFLICT(id) DO NOTHING. One row, key = singleton, written on first open.
CREATE TABLE IF NOT EXISTS db_meta (
    key TEXT PRIMARY KEY,
    generation INTEGER NOT NULL
);
`

// SandboxDB manages the per-sandbox SQLite database.
type SandboxDB struct {
	db         *sql.DB
	sandboxID  string
	generation int64
}

// OpenSandboxDB opens (or creates) the SQLite database for a sandbox.
//
// On first open the DB is stamped with a generation = UnixNano. This value is
// stable for the lifetime of the file (re-opens read the same value back) and
// is embedded into every upstream event's envelope ID so that hibernate+wake
// — which deletes and re-creates the file — gets a fresh generation, breaking
// the AUTOINCREMENT-id collision that previously caused post-wake events to
// be silently dropped by events-ingest's ON CONFLICT(id) DO NOTHING.
func OpenSandboxDB(dataDir, sandboxID string) (*SandboxDB, error) {
	dir := filepath.Join(dataDir, sandboxID)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create sandbox data dir: %w", err)
	}

	dbPath := filepath.Join(dir, "state.db")
	db, err := sql.Open("sqlite", dbPath+"?_pragma=journal_mode(wal)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite: %w", err)
	}

	if _, err := db.Exec(sqliteSchema); err != nil {
		db.Close()
		return nil, fmt.Errorf("failed to apply sqlite schema: %w", err)
	}

	if _, err := db.Exec(
		`INSERT OR IGNORE INTO db_meta (key, generation) VALUES ('singleton', ?)`,
		time.Now().UnixNano()); err != nil {
		db.Close()
		return nil, fmt.Errorf("failed to stamp db generation: %w", err)
	}
	var generation int64
	if err := db.QueryRow(`SELECT generation FROM db_meta WHERE key='singleton'`).Scan(&generation); err != nil {
		db.Close()
		return nil, fmt.Errorf("failed to read db generation: %w", err)
	}

	return &SandboxDB{db: db, sandboxID: sandboxID, generation: generation}, nil
}

// Generation returns the per-DB generation stamp embedded into upstream
// envelope IDs. Stable across re-opens; changes when the file is deleted and
// re-created (e.g. hibernate → wake).
func (s *SandboxDB) Generation() int64 {
	return s.generation
}

// Close closes the database connection.
func (s *SandboxDB) Close() error {
	return s.db.Close()
}

// LogCommand records a command execution.
func (s *SandboxDB) LogCommand(command string, args []string, cwd string, exitCode, durationMs, stdoutLen, stderrLen int) error {
	argsJSON, _ := json.Marshal(args)
	_, err := s.db.Exec(
		`INSERT INTO command_log (command, args, cwd, exit_code, duration_ms, stdout_len, stderr_len) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		command, string(argsJSON), cwd, exitCode, durationMs, stdoutLen, stderrLen)
	if err != nil {
		return fmt.Errorf("failed to log command: %w", err)
	}

	// Also insert an event for NATS sync
	payload, _ := json.Marshal(map[string]interface{}{
		"sandbox_id":  s.sandboxID,
		"command":     command,
		"args":        args,
		"cwd":         cwd,
		"exit_code":   exitCode,
		"duration_ms": durationMs,
	})
	_, err = s.db.Exec(
		`INSERT INTO events (type, payload) VALUES ('command', ?)`, string(payload))
	return err
}

// LogPTYStart records a PTY session start.
func (s *SandboxDB) LogPTYStart(sessionID string) error {
	_, err := s.db.Exec(`INSERT INTO pty_sessions (id) VALUES (?)`, sessionID)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]interface{}{
		"sandbox_id": s.sandboxID,
		"session_id": sessionID,
	})
	_, err = s.db.Exec(`INSERT INTO events (type, payload) VALUES ('pty_start', ?)`, string(payload))
	return err
}

// LogPTYEnd records a PTY session end.
func (s *SandboxDB) LogPTYEnd(sessionID string, bytesIn, bytesOut int64) error {
	_, err := s.db.Exec(
		`UPDATE pty_sessions SET ended_at = datetime('now'), bytes_in = ?, bytes_out = ? WHERE id = ?`,
		bytesIn, bytesOut, sessionID)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]interface{}{
		"sandbox_id": s.sandboxID,
		"session_id": sessionID,
		"bytes_in":   bytesIn,
		"bytes_out":  bytesOut,
	})
	_, err = s.db.Exec(`INSERT INTO events (type, payload) VALUES ('pty_end', ?)`, string(payload))
	return err
}

// LogEvent records a generic event.
func (s *SandboxDB) LogEvent(eventType string, payload interface{}) error {
	data, _ := json.Marshal(payload)
	_, err := s.db.Exec(`INSERT INTO events (type, payload) VALUES (?, ?)`, eventType, string(data))
	return err
}

// Event represents an unsynced event.
type Event struct {
	ID        int64
	Type      string
	Payload   string
	CreatedAt string
}

// GetUnsyncedEvents returns events that haven't been synced to NATS yet.
func (s *SandboxDB) GetUnsyncedEvents(limit int) ([]Event, error) {
	rows, err := s.db.Query(
		`SELECT id, type, payload, created_at FROM events WHERE synced = 0 ORDER BY id ASC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []Event
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.ID, &e.Type, &e.Payload, &e.CreatedAt); err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	return events, nil
}

// MarkEventsSynced marks the given event IDs as synced.
func (s *SandboxDB) MarkEventsSynced(ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`UPDATE events SET synced = 1 WHERE id = ?`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, id := range ids {
		if _, err := stmt.Exec(id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// RemoveSandboxData removes the SQLite database directory for a sandbox.
func RemoveSandboxData(dataDir, sandboxID string) error {
	dir := filepath.Join(dataDir, sandboxID)
	return os.RemoveAll(dir)
}

// SandboxDBManager manages SQLite databases for all sandboxes on a worker.
type SandboxDBManager struct {
	dataDir string
	mu      sync.RWMutex
	dbs     map[string]*SandboxDB

	// onRemove is invoked synchronously inside Remove BEFORE the SQLite
	// connection is closed and the file is deleted. The event publisher
	// registers a callback here so any unsynced terminal events (stopped,
	// hibernated) are flushed upstream before the per-sandbox DB goes
	// away. Without this hook, LogEvent("stopped") writes to SQLite but
	// the 2s publisher poll loses the race and the event never reaches
	// the events-ingest Worker, so D1 sandboxes_index keeps showing the
	// sandbox as running.
	onRemove func(sandboxID string)
}

// NewSandboxDBManager creates a new SandboxDB manager.
func NewSandboxDBManager(dataDir string) *SandboxDBManager {
	return &SandboxDBManager{
		dataDir: dataDir,
		dbs:     make(map[string]*SandboxDB),
	}
}

// SetOnRemove registers a callback invoked synchronously by Remove before the
// SQLite DB is closed and deleted. Used by the Redis event publisher to flush
// any pending terminal events for that sandbox to the cell's events stream.
// nil-safe; only one callback is supported (the second registration overwrites).
func (m *SandboxDBManager) SetOnRemove(fn func(sandboxID string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onRemove = fn
}

// Get returns the SandboxDB for a given sandbox, creating it if necessary.
func (m *SandboxDBManager) Get(sandboxID string) (*SandboxDB, error) {
	m.mu.RLock()
	if db, ok := m.dbs[sandboxID]; ok {
		m.mu.RUnlock()
		return db, nil
	}
	m.mu.RUnlock()

	m.mu.Lock()
	defer m.mu.Unlock()

	// Double-check after acquiring write lock
	if db, ok := m.dbs[sandboxID]; ok {
		return db, nil
	}

	db, err := OpenSandboxDB(m.dataDir, sandboxID)
	if err != nil {
		return nil, err
	}
	m.dbs[sandboxID] = db
	return db, nil
}

// Remove closes and removes the database for a sandbox. If an OnRemove hook
// is registered it is called synchronously BEFORE the SQLite file is closed,
// giving the event publisher a chance to flush any terminal events (stopped,
// hibernated, etc.) the caller wrote just before invoking Remove.
func (m *SandboxDBManager) Remove(sandboxID string) error {
	// Snapshot the hook + db handle under the lock. Run the hook outside
	// the lock so a slow flush doesn't block other Get/MarkSynced traffic.
	m.mu.Lock()
	hook := m.onRemove
	db, ok := m.dbs[sandboxID]
	m.mu.Unlock()

	if hook != nil {
		hook(sandboxID)
	}

	m.mu.Lock()
	delete(m.dbs, sandboxID)
	m.mu.Unlock()

	if ok {
		db.Close()
	}
	return RemoveSandboxData(m.dataDir, sandboxID)
}

// AllUnsyncedEvents collects unsynced events from all sandbox databases.
func (m *SandboxDBManager) AllUnsyncedEvents(limitPerDB int) (map[string][]Event, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make(map[string][]Event)
	for id, db := range m.dbs {
		events, err := db.GetUnsyncedEvents(limitPerDB)
		if err != nil {
			continue // Skip errored DBs, log in production
		}
		if len(events) > 0 {
			result[id] = events
		}
	}
	return result, nil
}

// MarkSynced marks events as synced in the given sandbox's database.
func (m *SandboxDBManager) MarkSynced(sandboxID string, ids []int64) error {
	m.mu.RLock()
	db, ok := m.dbs[sandboxID]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("sandbox %s not found", sandboxID)
	}
	return db.MarkEventsSynced(ids)
}

// Close closes all open databases.
func (m *SandboxDBManager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, db := range m.dbs {
		db.Close()
	}
	m.dbs = make(map[string]*SandboxDB)
}

// GetAllUnsyncedEventsFlat returns all unsynced events across all sandboxes as a flat list
// with sandbox ID attached, useful for the NATS event publisher.
type SandboxEvent struct {
	SandboxID  string
	Generation int64
	Event      Event
	Timestamp  time.Time
}

func (m *SandboxDBManager) GetAllUnsyncedEventsFlat(limitPerDB int) ([]SandboxEvent, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var flat []SandboxEvent
	for sandboxID, db := range m.dbs {
		events, err := db.GetUnsyncedEvents(limitPerDB)
		if err != nil {
			continue
		}
		gen := db.Generation()
		for _, e := range events {
			ts, _ := time.Parse("2006-01-02 15:04:05", e.CreatedAt)
			flat = append(flat, SandboxEvent{
				SandboxID:  sandboxID,
				Generation: gen,
				Event:      e,
				Timestamp:  ts,
			})
		}
	}
	return flat, nil
}
