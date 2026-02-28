package db

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Repository represents a git repository record.
type Repository struct {
	ID            uuid.UUID  `json:"id"`
	OrgID         uuid.UUID  `json:"orgId"`
	Name          string     `json:"name"`
	Slug          string     `json:"slug"`
	Description   string     `json:"description"`
	DefaultBranch string     `json:"defaultBranch"`
	SizeBytes     int64      `json:"sizeBytes"`
	LastPushAt    *time.Time `json:"lastPushAt,omitempty"`
	LastBackupAt  *time.Time `json:"lastBackupAt,omitempty"`
	BackupKey     *string    `json:"backupKey,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
	DeletedAt     *time.Time `json:"deletedAt,omitempty"`
}

// CreateRepository inserts a new repository for an org.
func (s *Store) CreateRepository(ctx context.Context, orgID uuid.UUID, name, slug, description string) (*Repository, error) {
	repo := &Repository{}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO repositories (org_id, name, slug, description)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, org_id, name, slug, description, default_branch, size_bytes, last_push_at, last_backup_at, backup_key, created_at, deleted_at`,
		orgID, name, slug, description,
	).Scan(&repo.ID, &repo.OrgID, &repo.Name, &repo.Slug, &repo.Description,
		&repo.DefaultBranch, &repo.SizeBytes, &repo.LastPushAt, &repo.LastBackupAt,
		&repo.BackupKey, &repo.CreatedAt, &repo.DeletedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to create repository: %w", err)
	}
	return repo, nil
}

// GetRepository looks up a repository by org ID and slug.
func (s *Store) GetRepository(ctx context.Context, orgID uuid.UUID, slug string) (*Repository, error) {
	repo := &Repository{}
	err := s.pool.QueryRow(ctx,
		`SELECT id, org_id, name, slug, description, default_branch, size_bytes, last_push_at, last_backup_at, backup_key, created_at, deleted_at
		 FROM repositories WHERE org_id = $1 AND slug = $2 AND deleted_at IS NULL`,
		orgID, slug,
	).Scan(&repo.ID, &repo.OrgID, &repo.Name, &repo.Slug, &repo.Description,
		&repo.DefaultBranch, &repo.SizeBytes, &repo.LastPushAt, &repo.LastBackupAt,
		&repo.BackupKey, &repo.CreatedAt, &repo.DeletedAt)
	if err != nil {
		return nil, fmt.Errorf("repository not found: %w", err)
	}
	return repo, nil
}

// GetRepositoryByID looks up a repository by its UUID.
func (s *Store) GetRepositoryByID(ctx context.Context, id uuid.UUID) (*Repository, error) {
	repo := &Repository{}
	err := s.pool.QueryRow(ctx,
		`SELECT id, org_id, name, slug, description, default_branch, size_bytes, last_push_at, last_backup_at, backup_key, created_at, deleted_at
		 FROM repositories WHERE id = $1 AND deleted_at IS NULL`, id,
	).Scan(&repo.ID, &repo.OrgID, &repo.Name, &repo.Slug, &repo.Description,
		&repo.DefaultBranch, &repo.SizeBytes, &repo.LastPushAt, &repo.LastBackupAt,
		&repo.BackupKey, &repo.CreatedAt, &repo.DeletedAt)
	if err != nil {
		return nil, fmt.Errorf("repository not found: %w", err)
	}
	return repo, nil
}

// ListRepositories returns all active repositories for an org.
func (s *Store) ListRepositories(ctx context.Context, orgID uuid.UUID) ([]Repository, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, org_id, name, slug, description, default_branch, size_bytes, last_push_at, last_backup_at, backup_key, created_at, deleted_at
		 FROM repositories WHERE org_id = $1 AND deleted_at IS NULL
		 ORDER BY name ASC`, orgID)
	if err != nil {
		return nil, fmt.Errorf("failed to list repositories: %w", err)
	}
	defer rows.Close()

	var repos []Repository
	for rows.Next() {
		var r Repository
		if err := rows.Scan(&r.ID, &r.OrgID, &r.Name, &r.Slug, &r.Description,
			&r.DefaultBranch, &r.SizeBytes, &r.LastPushAt, &r.LastBackupAt,
			&r.BackupKey, &r.CreatedAt, &r.DeletedAt); err != nil {
			return nil, err
		}
		repos = append(repos, r)
	}
	return repos, nil
}

// DeleteRepository soft-deletes a repository by setting deleted_at.
func (s *Store) DeleteRepository(ctx context.Context, orgID uuid.UUID, slug string) error {
	result, err := s.pool.Exec(ctx,
		`UPDATE repositories SET deleted_at = now()
		 WHERE org_id = $1 AND slug = $2 AND deleted_at IS NULL`,
		orgID, slug)
	if err != nil {
		return fmt.Errorf("failed to delete repository: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("repository not found")
	}
	return nil
}

// UpdateRepoLastPush updates the last push timestamp and repo size.
func (s *Store) UpdateRepoLastPush(ctx context.Context, repoID uuid.UUID, sizeBytes int64) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE repositories SET last_push_at = now(), size_bytes = $1 WHERE id = $2`,
		sizeBytes, repoID)
	return err
}

// UpdateRepoBackup records a successful S3 backup for a repository.
func (s *Store) UpdateRepoBackup(ctx context.Context, repoID uuid.UUID, backupKey string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE repositories SET last_backup_at = now(), backup_key = $1 WHERE id = $2`,
		backupKey, repoID)
	return err
}
