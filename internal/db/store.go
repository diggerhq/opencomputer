package db

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Store provides data access to the global PostgreSQL database.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore creates a new Store with a connection pool.
func NewStore(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to database: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}
	return &Store{pool: pool}, nil
}

// Close closes the connection pool.
func (s *Store) Close() {
	s.pool.Close()
}

// Migrate runs database migrations.
func (s *Store) Migrate(ctx context.Context) error {
	// Create migrations tracking table
	_, err := s.pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`)
	if err != nil {
		return fmt.Errorf("failed to create migrations table: %w", err)
	}

	// Check current version
	var currentVersion int
	err = s.pool.QueryRow(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&currentVersion)
	if err != nil {
		return fmt.Errorf("failed to get current migration version: %w", err)
	}

	migrations := []struct {
		version  int
		filename string
	}{
		{1, "migrations/001_initial.up.sql"},
		{2, "migrations/002_user_sessions.up.sql"},
	}

	for _, m := range migrations {
		if currentVersion >= m.version {
			continue
		}
		sql, err := migrationsFS.ReadFile(m.filename)
		if err != nil {
			return fmt.Errorf("failed to read migration file %s: %w", m.filename, err)
		}
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return fmt.Errorf("failed to begin transaction for migration %d: %w", m.version, err)
		}
		defer tx.Rollback(ctx)

		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			return fmt.Errorf("failed to apply migration %03d: %w", m.version, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, m.version); err != nil {
			return fmt.Errorf("failed to record migration %03d: %w", m.version, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("failed to commit migration %03d: %w", m.version, err)
		}
	}

	return nil
}

// --- Org operations ---

type Org struct {
	ID                     uuid.UUID `json:"id"`
	Name                   string    `json:"name"`
	Slug                   string    `json:"slug"`
	Plan                   string    `json:"plan"`
	MaxConcurrentSandboxes int       `json:"maxConcurrentSandboxes"`
	MaxSandboxTimeoutSec   int       `json:"maxSandboxTimeoutSec"`
	CreatedAt              time.Time `json:"createdAt"`
	UpdatedAt              time.Time `json:"updatedAt"`
}

func (s *Store) CreateOrg(ctx context.Context, name, slug string) (*Org, error) {
	org := &Org{}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO orgs (name, slug) VALUES ($1, $2)
		 RETURNING id, name, slug, plan, max_concurrent_sandboxes, max_sandbox_timeout_sec, created_at, updated_at`,
		name, slug,
	).Scan(&org.ID, &org.Name, &org.Slug, &org.Plan, &org.MaxConcurrentSandboxes,
		&org.MaxSandboxTimeoutSec, &org.CreatedAt, &org.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to create org: %w", err)
	}
	return org, nil
}

func (s *Store) GetOrg(ctx context.Context, id uuid.UUID) (*Org, error) {
	org := &Org{}
	err := s.pool.QueryRow(ctx,
		`SELECT id, name, slug, plan, max_concurrent_sandboxes, max_sandbox_timeout_sec, created_at, updated_at
		 FROM orgs WHERE id = $1`, id,
	).Scan(&org.ID, &org.Name, &org.Slug, &org.Plan, &org.MaxConcurrentSandboxes,
		&org.MaxSandboxTimeoutSec, &org.CreatedAt, &org.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("org not found: %w", err)
	}
	return org, nil
}

func (s *Store) GetOrgBySlug(ctx context.Context, slug string) (*Org, error) {
	org := &Org{}
	err := s.pool.QueryRow(ctx,
		`SELECT id, name, slug, plan, max_concurrent_sandboxes, max_sandbox_timeout_sec, created_at, updated_at
		 FROM orgs WHERE slug = $1`, slug,
	).Scan(&org.ID, &org.Name, &org.Slug, &org.Plan, &org.MaxConcurrentSandboxes,
		&org.MaxSandboxTimeoutSec, &org.CreatedAt, &org.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("org not found: %w", err)
	}
	return org, nil
}

func (s *Store) UpdateOrg(ctx context.Context, id uuid.UUID, name string) (*Org, error) {
	org := &Org{}
	err := s.pool.QueryRow(ctx,
		`UPDATE orgs SET name = $1, updated_at = now() WHERE id = $2
		 RETURNING id, name, slug, plan, max_concurrent_sandboxes, max_sandbox_timeout_sec, created_at, updated_at`,
		name, id,
	).Scan(&org.ID, &org.Name, &org.Slug, &org.Plan, &org.MaxConcurrentSandboxes,
		&org.MaxSandboxTimeoutSec, &org.CreatedAt, &org.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to update org: %w", err)
	}
	return org, nil
}

// --- User operations ---

type User struct {
	ID        uuid.UUID `json:"id"`
	OrgID     uuid.UUID `json:"orgId"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"createdAt"`
}

func (s *Store) CreateUser(ctx context.Context, orgID uuid.UUID, email, name, role string) (*User, error) {
	user := &User{}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO users (org_id, email, name, role) VALUES ($1, $2, $3, $4)
		 RETURNING id, org_id, email, name, role, created_at`,
		orgID, email, name, role,
	).Scan(&user.ID, &user.OrgID, &user.Email, &user.Name, &user.Role, &user.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to create user: %w", err)
	}
	return user, nil
}

func (s *Store) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	user := &User{}
	err := s.pool.QueryRow(ctx,
		`SELECT id, org_id, email, name, role, created_at FROM users WHERE email = $1`, email,
	).Scan(&user.ID, &user.OrgID, &user.Email, &user.Name, &user.Role, &user.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("user not found: %w", err)
	}
	return user, nil
}

// --- API Key operations ---

type APIKey struct {
	ID        uuid.UUID  `json:"id"`
	OrgID     uuid.UUID  `json:"orgId"`
	CreatedBy *uuid.UUID `json:"createdBy,omitempty"`
	KeyPrefix string     `json:"keyPrefix"`
	Name      string     `json:"name"`
	Scopes    []string   `json:"scopes"`
	LastUsed  *time.Time `json:"lastUsed,omitempty"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
}

// HashAPIKey returns the SHA-256 hash of a plaintext API key.
func HashAPIKey(key string) string {
	h := sha256.Sum256([]byte(key))
	return hex.EncodeToString(h[:])
}

func (s *Store) CreateAPIKey(ctx context.Context, orgID uuid.UUID, createdBy *uuid.UUID, keyHash, keyPrefix, name string, scopes []string) (*APIKey, error) {
	apiKey := &APIKey{}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO api_keys (org_id, created_by, key_hash, key_prefix, name, scopes)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id, org_id, created_by, key_prefix, name, scopes, created_at`,
		orgID, createdBy, keyHash, keyPrefix, name, scopes,
	).Scan(&apiKey.ID, &apiKey.OrgID, &apiKey.CreatedBy, &apiKey.KeyPrefix, &apiKey.Name,
		&apiKey.Scopes, &apiKey.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to create API key: %w", err)
	}
	return apiKey, nil
}

// ValidateAPIKey looks up an API key by hash and returns the associated org ID.
func (s *Store) ValidateAPIKey(ctx context.Context, keyPlaintext string) (uuid.UUID, error) {
	hash := HashAPIKey(keyPlaintext)
	var orgID uuid.UUID
	var expiresAt *time.Time
	err := s.pool.QueryRow(ctx,
		`SELECT org_id, expires_at FROM api_keys WHERE key_hash = $1`, hash,
	).Scan(&orgID, &expiresAt)
	if err != nil {
		return uuid.Nil, fmt.Errorf("invalid API key")
	}
	if expiresAt != nil && expiresAt.Before(time.Now()) {
		return uuid.Nil, fmt.Errorf("API key expired")
	}
	// Update last_used
	_, _ = s.pool.Exec(ctx, `UPDATE api_keys SET last_used = now() WHERE key_hash = $1`, hash)
	return orgID, nil
}

func (s *Store) ListAPIKeys(ctx context.Context, orgID uuid.UUID) ([]APIKey, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, org_id, created_by, key_prefix, name, scopes, last_used, expires_at, created_at
		 FROM api_keys WHERE org_id = $1 ORDER BY created_at DESC`, orgID)
	if err != nil {
		return nil, fmt.Errorf("failed to list API keys: %w", err)
	}
	defer rows.Close()

	var keys []APIKey
	for rows.Next() {
		var k APIKey
		if err := rows.Scan(&k.ID, &k.OrgID, &k.CreatedBy, &k.KeyPrefix, &k.Name,
			&k.Scopes, &k.LastUsed, &k.ExpiresAt, &k.CreatedAt); err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	return keys, nil
}

func (s *Store) DeleteAPIKey(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM api_keys WHERE id = $1`, id)
	return err
}

// --- Sandbox Session operations ---

type SandboxSession struct {
	ID        uuid.UUID  `json:"id"`
	SandboxID string     `json:"sandboxId"`
	OrgID     uuid.UUID  `json:"orgId"`
	UserID    *uuid.UUID `json:"userId,omitempty"`
	Template  string     `json:"template"`
	Region    string     `json:"region"`
	WorkerID  string     `json:"workerId"`
	Status    string     `json:"status"`
	Config    json.RawMessage `json:"config"`
	Metadata  json.RawMessage `json:"metadata,omitempty"`
	StartedAt time.Time  `json:"startedAt"`
	StoppedAt *time.Time `json:"stoppedAt,omitempty"`
	ErrorMsg  *string    `json:"errorMsg,omitempty"`
}

func (s *Store) CreateSandboxSession(ctx context.Context, sandboxID string, orgID uuid.UUID, userID *uuid.UUID, template, region, workerID string, config, metadata json.RawMessage) (*SandboxSession, error) {
	session := &SandboxSession{}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO sandbox_sessions (sandbox_id, org_id, user_id, template, region, worker_id, config, metadata)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 RETURNING id, sandbox_id, org_id, user_id, template, region, worker_id, status, config, metadata, started_at`,
		sandboxID, orgID, userID, template, region, workerID, config, metadata,
	).Scan(&session.ID, &session.SandboxID, &session.OrgID, &session.UserID, &session.Template,
		&session.Region, &session.WorkerID, &session.Status, &session.Config, &session.Metadata, &session.StartedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to create sandbox session: %w", err)
	}
	return session, nil
}

func (s *Store) UpdateSandboxSessionStatus(ctx context.Context, sandboxID, status string, errorMsg *string) error {
	var query string
	var args []interface{}
	if status == "stopped" || status == "error" {
		query = `UPDATE sandbox_sessions SET status = $1, stopped_at = now(), error_msg = $2 WHERE sandbox_id = $3 AND status = 'running'`
		args = []interface{}{status, errorMsg, sandboxID}
	} else {
		query = `UPDATE sandbox_sessions SET status = $1 WHERE sandbox_id = $2 AND status = 'running'`
		args = []interface{}{status, sandboxID}
	}
	_, err := s.pool.Exec(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("failed to update sandbox session: %w", err)
	}
	return nil
}

func (s *Store) GetSandboxSession(ctx context.Context, sandboxID string) (*SandboxSession, error) {
	session := &SandboxSession{}
	err := s.pool.QueryRow(ctx,
		`SELECT id, sandbox_id, org_id, user_id, template, region, worker_id, status, config, metadata, started_at, stopped_at, error_msg
		 FROM sandbox_sessions WHERE sandbox_id = $1 ORDER BY started_at DESC LIMIT 1`, sandboxID,
	).Scan(&session.ID, &session.SandboxID, &session.OrgID, &session.UserID, &session.Template,
		&session.Region, &session.WorkerID, &session.Status, &session.Config, &session.Metadata,
		&session.StartedAt, &session.StoppedAt, &session.ErrorMsg)
	if err != nil {
		return nil, fmt.Errorf("sandbox session not found: %w", err)
	}
	return session, nil
}

func (s *Store) ListSandboxSessions(ctx context.Context, orgID uuid.UUID, status string, limit, offset int) ([]SandboxSession, error) {
	var rows pgx.Rows
	var err error
	if status != "" {
		rows, err = s.pool.Query(ctx,
			`SELECT id, sandbox_id, org_id, user_id, template, region, worker_id, status, config, metadata, started_at, stopped_at, error_msg
			 FROM sandbox_sessions WHERE org_id = $1 AND status = $2 ORDER BY started_at DESC LIMIT $3 OFFSET $4`,
			orgID, status, limit, offset)
	} else {
		rows, err = s.pool.Query(ctx,
			`SELECT id, sandbox_id, org_id, user_id, template, region, worker_id, status, config, metadata, started_at, stopped_at, error_msg
			 FROM sandbox_sessions WHERE org_id = $1 ORDER BY started_at DESC LIMIT $2 OFFSET $3`,
			orgID, limit, offset)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to list sandbox sessions: %w", err)
	}
	defer rows.Close()

	var sessions []SandboxSession
	for rows.Next() {
		var sess SandboxSession
		if err := rows.Scan(&sess.ID, &sess.SandboxID, &sess.OrgID, &sess.UserID, &sess.Template,
			&sess.Region, &sess.WorkerID, &sess.Status, &sess.Config, &sess.Metadata,
			&sess.StartedAt, &sess.StoppedAt, &sess.ErrorMsg); err != nil {
			return nil, err
		}
		sessions = append(sessions, sess)
	}
	return sessions, nil
}

func (s *Store) CountActiveSandboxes(ctx context.Context, orgID uuid.UUID) (int, error) {
	var count int
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM sandbox_sessions WHERE org_id = $1 AND status = 'running'`, orgID,
	).Scan(&count)
	return count, err
}

// --- Command Log operations (for NATS sync consumer) ---

type CommandLog struct {
	ID         uuid.UUID `json:"id"`
	SandboxID  string    `json:"sandboxId"`
	Command    string    `json:"command"`
	Args       []string  `json:"args,omitempty"`
	Cwd        string    `json:"cwd,omitempty"`
	ExitCode   *int      `json:"exitCode,omitempty"`
	DurationMs *int      `json:"durationMs,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
}

func (s *Store) InsertCommandLog(ctx context.Context, sandboxID, command string, args []string, cwd string, exitCode, durationMs *int) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO command_logs (sandbox_id, command, args, cwd, exit_code, duration_ms)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		sandboxID, command, args, cwd, exitCode, durationMs)
	return err
}

func (s *Store) InsertCommandLogBatch(ctx context.Context, logs []CommandLog) error {
	if len(logs) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, l := range logs {
		batch.Queue(
			`INSERT INTO command_logs (sandbox_id, command, args, cwd, exit_code, duration_ms, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			l.SandboxID, l.Command, l.Args, l.Cwd, l.ExitCode, l.DurationMs, l.CreatedAt)
	}
	br := s.pool.SendBatch(ctx, batch)
	defer br.Close()
	for range logs {
		if _, err := br.Exec(); err != nil {
			return fmt.Errorf("failed to insert command log batch: %w", err)
		}
	}
	return nil
}

// --- Worker Registry operations ---

type Worker struct {
	ID            string     `json:"id"`
	Region        string     `json:"region"`
	GRPCAddr      string     `json:"grpcAddr"`
	HTTPAddr      string     `json:"httpAddr"`
	Capacity      int        `json:"capacity"`
	CurrentCount  int        `json:"currentCount"`
	Status        string     `json:"status"`
	LastHeartbeat *time.Time `json:"lastHeartbeat,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
}

func (s *Store) UpsertWorker(ctx context.Context, w *Worker) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO workers (id, region, grpc_addr, http_addr, capacity, current_count, status, last_heartbeat)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, now())
		 ON CONFLICT (id) DO UPDATE SET
		   current_count = EXCLUDED.current_count,
		   status = EXCLUDED.status,
		   last_heartbeat = now()`,
		w.ID, w.Region, w.GRPCAddr, w.HTTPAddr, w.Capacity, w.CurrentCount, w.Status)
	return err
}

func (s *Store) ListHealthyWorkers(ctx context.Context, region string) ([]Worker, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, region, grpc_addr, http_addr, capacity, current_count, status, last_heartbeat, created_at
		 FROM workers WHERE region = $1 AND status = 'healthy'
		 ORDER BY (capacity - current_count) DESC`, region)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var workers []Worker
	for rows.Next() {
		var w Worker
		if err := rows.Scan(&w.ID, &w.Region, &w.GRPCAddr, &w.HTTPAddr, &w.Capacity, &w.CurrentCount,
			&w.Status, &w.LastHeartbeat, &w.CreatedAt); err != nil {
			return nil, err
		}
		workers = append(workers, w)
	}
	return workers, nil
}

// --- User Session (access token) operations ---

// StoreAccessToken stores a WorkOS access token mapped to a user ID.
// Replaces any existing token for the user.
func (s *Store) StoreAccessToken(ctx context.Context, userID uuid.UUID, accessToken string) error {
	// Delete old sessions for this user
	_, _ = s.pool.Exec(ctx, `DELETE FROM user_sessions WHERE user_id = $1`, userID)
	// Insert new session
	_, err := s.pool.Exec(ctx,
		`INSERT INTO user_sessions (user_id, access_token) VALUES ($1, $2)`,
		userID, accessToken)
	return err
}

// GetUserByAccessToken looks up a user by their active access token.
func (s *Store) GetUserByAccessToken(ctx context.Context, accessToken string) (*User, error) {
	user := &User{}
	err := s.pool.QueryRow(ctx,
		`SELECT u.id, u.org_id, u.email, u.name, u.role, u.created_at
		 FROM users u
		 INNER JOIN user_sessions s ON s.user_id = u.id
		 WHERE s.access_token = $1 AND s.expires_at > now()`,
		accessToken,
	).Scan(&user.ID, &user.OrgID, &user.Email, &user.Name, &user.Role, &user.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("session not found or expired: %w", err)
	}
	return user, nil
}

// DeleteAccessTokensForUser removes all sessions for a user (logout).
func (s *Store) DeleteAccessTokensForUser(ctx context.Context, userID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM user_sessions WHERE user_id = $1`, userID)
	return err
}

// Pool returns the underlying pgx pool for advanced use cases.
func (s *Store) Pool() *pgxpool.Pool {
	return s.pool
}
