// Package secrets provides the data access layer for the secrets service.
// Extracted from internal/db/store.go — same SQL queries, own connection pool.
package secrets

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opensandbox/opensandbox/internal/crypto"
)

// Secret represents a row in org_secrets. The encrypted_value is never returned
// to API callers; use GetSecretValue to decrypt.
type Secret struct {
	ID          uuid.UUID `json:"id"`
	OrgID       uuid.UUID `json:"orgId"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// SecretGroup represents a row in secret_groups.
type SecretGroup struct {
	ID           uuid.UUID `json:"id"`
	OrgID        uuid.UUID `json:"orgId"`
	Name         string    `json:"name"`
	Description  string    `json:"description"`
	AllowedHosts []string  `json:"allowedHosts,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
}

// SecretGroupEntry represents a row in secret_group_entries (with joined secret name).
type SecretGroupEntry struct {
	ID         uuid.UUID `json:"id"`
	GroupID    uuid.UUID `json:"groupId"`
	SecretID   uuid.UUID `json:"secretId"`
	SecretName string    `json:"secretName,omitempty"`
	EnvVarName string    `json:"envVarName"`
}

// SecretGroupEntryInput is used when setting entries on a group.
type SecretGroupEntryInput struct {
	SecretID   uuid.UUID
	EnvVarName string
}

// Store provides secrets data access with its own PG connection pool.
type Store struct {
	pool   *pgxpool.Pool
	keyRing *crypto.KeyRing
}

// NewStore creates a new secrets Store.
func NewStore(pool *pgxpool.Pool, keyRing *crypto.KeyRing) *Store {
	return &Store{pool: pool, keyRing: keyRing}
}

// --- Secret CRUD ---

// CreateSecret stores a new secret with the plaintext value encrypted at rest.
func (s *Store) CreateSecret(ctx context.Context, orgID uuid.UUID, name, description, plaintextValue string) (*Secret, error) {
	encrypted, err := s.keyRing.Encrypt(plaintextValue)
	if err != nil {
		return nil, fmt.Errorf("encrypt secret: %w", err)
	}
	secret := &Secret{}
	err = s.pool.QueryRow(ctx,
		`INSERT INTO org_secrets (org_id, name, description, encrypted_value)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, org_id, name, COALESCE(description,''), created_at, updated_at`,
		orgID, name, description, encrypted,
	).Scan(&secret.ID, &secret.OrgID, &secret.Name, &secret.Description, &secret.CreatedAt, &secret.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create secret: %w", err)
	}
	return secret, nil
}

// ListSecrets returns all secrets for an org. Values are never included.
func (s *Store) ListSecrets(ctx context.Context, orgID uuid.UUID) ([]Secret, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, org_id, name, COALESCE(description,''), created_at, updated_at
		 FROM org_secrets WHERE org_id = $1 ORDER BY name ASC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var secrets []Secret
	for rows.Next() {
		var sec Secret
		if err := rows.Scan(&sec.ID, &sec.OrgID, &sec.Name, &sec.Description, &sec.CreatedAt, &sec.UpdatedAt); err != nil {
			return nil, err
		}
		secrets = append(secrets, sec)
	}
	return secrets, nil
}

// UpdateSecret updates the name, description, and/or value of a secret.
// Pass empty string for name/description to leave unchanged; pass nil valuePtr to skip value update.
func (s *Store) UpdateSecret(ctx context.Context, orgID, secretID uuid.UUID, name, description string, newValue *string) error {
	if newValue != nil {
		encrypted, err := s.keyRing.Encrypt(*newValue)
		if err != nil {
			return fmt.Errorf("encrypt secret: %w", err)
		}
		_, err = s.pool.Exec(ctx,
			`UPDATE org_secrets SET name = COALESCE(NULLIF($1,''), name),
			 description = COALESCE(NULLIF($2,''), description),
			 encrypted_value = $3, updated_at = now()
			 WHERE id = $4 AND org_id = $5`,
			name, description, encrypted, secretID, orgID)
		return err
	}
	_, err := s.pool.Exec(ctx,
		`UPDATE org_secrets SET name = COALESCE(NULLIF($1,''), name),
		 description = COALESCE(NULLIF($2,''), description),
		 updated_at = now()
		 WHERE id = $3 AND org_id = $4`,
		name, description, secretID, orgID)
	return err
}

// DeleteSecret deletes a secret scoped to the given org.
func (s *Store) DeleteSecret(ctx context.Context, orgID, secretID uuid.UUID) error {
	result, err := s.pool.Exec(ctx,
		`DELETE FROM org_secrets WHERE id = $1 AND org_id = $2`, secretID, orgID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("secret not found or not owned by this org")
	}
	return nil
}

// GetSecretValue decrypts and returns the plaintext value of a secret.
func (s *Store) GetSecretValue(ctx context.Context, secretID uuid.UUID) (string, error) {
	var encrypted string
	if err := s.pool.QueryRow(ctx,
		`SELECT encrypted_value FROM org_secrets WHERE id = $1`, secretID,
	).Scan(&encrypted); err != nil {
		if err == pgx.ErrNoRows {
			return "", fmt.Errorf("secret not found")
		}
		return "", fmt.Errorf("secret not found: %w", err)
	}
	result, err := s.keyRing.Decrypt(encrypted)
	if err != nil {
		return "", err
	}
	if result.NeedsRekey {
		s.rekeySecret(secretID, result.Plaintext)
	}
	return result.Plaintext, nil
}

// rekeySecret re-encrypts a secret with the active key version (fire-and-forget).
func (s *Store) rekeySecret(secretID uuid.UUID, plaintext string) {
	reencrypted, err := s.keyRing.Encrypt(plaintext)
	if err != nil {
		return
	}
	go s.pool.Exec(context.Background(),
		`UPDATE org_secrets SET encrypted_value = $1, updated_at = now() WHERE id = $2`,
		reencrypted, secretID)
}

// --- Secret Group CRUD ---

// CreateSecretGroup creates a new secret group.
func (s *Store) CreateSecretGroup(ctx context.Context, orgID uuid.UUID, name, description string, allowedHosts []string) (*SecretGroup, error) {
	g := &SecretGroup{}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO secret_groups (org_id, name, description, allowed_hosts)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, org_id, name, COALESCE(description,''), COALESCE(allowed_hosts, '{}'), created_at`,
		orgID, name, description, allowedHosts,
	).Scan(&g.ID, &g.OrgID, &g.Name, &g.Description, &g.AllowedHosts, &g.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create secret group: %w", err)
	}
	return g, nil
}

// ListSecretGroups returns all secret groups for an org.
func (s *Store) ListSecretGroups(ctx context.Context, orgID uuid.UUID) ([]SecretGroup, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, org_id, name, COALESCE(description,''), COALESCE(allowed_hosts, '{}'), created_at
		 FROM secret_groups WHERE org_id = $1 ORDER BY name ASC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var groups []SecretGroup
	for rows.Next() {
		var g SecretGroup
		if err := rows.Scan(&g.ID, &g.OrgID, &g.Name, &g.Description, &g.AllowedHosts, &g.CreatedAt); err != nil {
			return nil, err
		}
		groups = append(groups, g)
	}
	return groups, nil
}

// GetSecretGroup returns a single secret group scoped to the org.
func (s *Store) GetSecretGroup(ctx context.Context, orgID, groupID uuid.UUID) (*SecretGroup, error) {
	g := &SecretGroup{}
	err := s.pool.QueryRow(ctx,
		`SELECT id, org_id, name, COALESCE(description,''), COALESCE(allowed_hosts, '{}'), created_at
		 FROM secret_groups WHERE id = $1 AND org_id = $2`,
		groupID, orgID,
	).Scan(&g.ID, &g.OrgID, &g.Name, &g.Description, &g.AllowedHosts, &g.CreatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("secret group not found")
		}
		return nil, fmt.Errorf("secret group not found: %w", err)
	}
	return g, nil
}

// UpdateSecretGroup updates name, description, and allowed_hosts of a group.
func (s *Store) UpdateSecretGroup(ctx context.Context, orgID, groupID uuid.UUID, name, description string, allowedHosts []string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE secret_groups SET
		 name = COALESCE(NULLIF($1,''), name),
		 description = COALESCE(NULLIF($2,''), description),
		 allowed_hosts = $3
		 WHERE id = $4 AND org_id = $5`,
		name, description, allowedHosts, groupID, orgID)
	return err
}

// DeleteSecretGroup deletes a group scoped to the org.
func (s *Store) DeleteSecretGroup(ctx context.Context, orgID, groupID uuid.UUID) error {
	result, err := s.pool.Exec(ctx,
		`DELETE FROM secret_groups WHERE id = $1 AND org_id = $2`, groupID, orgID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("secret group not found or not owned by this org")
	}
	return nil
}

// --- Secret Group Entries ---

// SetSecretGroupEntries replaces all entries for a group (delete + insert).
func (s *Store) SetSecretGroupEntries(ctx context.Context, groupID uuid.UUID, entries []SecretGroupEntryInput) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DELETE FROM secret_group_entries WHERE group_id = $1`, groupID); err != nil {
		return err
	}
	for _, e := range entries {
		if _, err := tx.Exec(ctx,
			`INSERT INTO secret_group_entries (group_id, secret_id, env_var_name) VALUES ($1, $2, $3)`,
			groupID, e.SecretID, e.EnvVarName); err != nil {
			return fmt.Errorf("insert entry %s: %w", e.EnvVarName, err)
		}
	}
	return tx.Commit(ctx)
}

// GetSecretGroupEntries returns all entries for a group with secret names joined.
func (s *Store) GetSecretGroupEntries(ctx context.Context, groupID uuid.UUID) ([]SecretGroupEntry, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT sge.id, sge.group_id, sge.secret_id, os.name, sge.env_var_name
		 FROM secret_group_entries sge
		 JOIN org_secrets os ON os.id = sge.secret_id
		 WHERE sge.group_id = $1
		 ORDER BY sge.env_var_name ASC`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []SecretGroupEntry
	for rows.Next() {
		var e SecretGroupEntry
		if err := rows.Scan(&e.ID, &e.GroupID, &e.SecretID, &e.SecretName, &e.EnvVarName); err != nil {
			return nil, err
		}
		result = append(result, e)
	}
	return result, nil
}

// --- Resolve ---

// ResolveSecretGroup decrypts all secrets in a group and returns a map of
// {envVarName: plaintextValue} plus the allowed_hosts list.
func (s *Store) ResolveSecretGroup(ctx context.Context, groupID uuid.UUID) (envVars map[string]string, allowedHosts []string, err error) {
	rows, err := s.pool.Query(ctx,
		`SELECT sge.env_var_name, os.id, os.encrypted_value, sg.allowed_hosts
		 FROM secret_group_entries sge
		 JOIN org_secrets os ON os.id = sge.secret_id
		 JOIN secret_groups sg ON sg.id = sge.group_id
		 WHERE sge.group_id = $1`, groupID)
	if err != nil {
		return nil, nil, fmt.Errorf("query secret group: %w", err)
	}
	defer rows.Close()

	envVars = make(map[string]string)
	for rows.Next() {
		var envVar, encrypted string
		var secretID uuid.UUID
		var hosts []string
		if err := rows.Scan(&envVar, &secretID, &encrypted, &hosts); err != nil {
			return nil, nil, err
		}
		if allowedHosts == nil {
			allowedHosts = hosts
		}
		result, err := s.keyRing.Decrypt(encrypted)
		if err != nil {
			return nil, nil, fmt.Errorf("decrypt secret for %s: %w", envVar, err)
		}
		envVars[envVar] = result.Plaintext
		if result.NeedsRekey {
			s.rekeySecret(secretID, result.Plaintext)
		}
	}
	return envVars, allowedHosts, nil
}
