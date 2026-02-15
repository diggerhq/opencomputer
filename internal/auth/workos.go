package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/internal/db"
)

// WorkOSConfig holds WorkOS integration settings.
type WorkOSConfig struct {
	APIKey   string
	ClientID string
}

// WorkOSMiddleware validates WorkOS session tokens for dashboard access.
// It checks for a session cookie or Authorization header, validates with WorkOS,
// and provisions orgs/users in the local database on first login.
type WorkOSMiddleware struct {
	config WorkOSConfig
	store  *db.Store
}

// NewWorkOSMiddleware creates WorkOS session middleware.
func NewWorkOSMiddleware(config WorkOSConfig, store *db.Store) *WorkOSMiddleware {
	return &WorkOSMiddleware{config: config, store: store}
}

// Middleware returns the Echo middleware function.
func (w *WorkOSMiddleware) Middleware() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			// Skip if WorkOS is not configured
			if w.config.APIKey == "" {
				return next(c)
			}

			// Extract session token from cookie or header
			sessionToken := ""
			if cookie, err := c.Cookie("workos_session"); err == nil {
				sessionToken = cookie.Value
			}
			if sessionToken == "" {
				auth := c.Request().Header.Get("Authorization")
				if strings.HasPrefix(auth, "Bearer wos_") {
					sessionToken = strings.TrimPrefix(auth, "Bearer ")
				}
			}

			if sessionToken == "" {
				return c.JSON(http.StatusUnauthorized, map[string]string{
					"error": "authentication required",
				})
			}

			// Validate session with WorkOS
			user, err := w.validateSession(c.Request().Context(), sessionToken)
			if err != nil {
				return c.JSON(http.StatusUnauthorized, map[string]string{
					"error": "invalid session: " + err.Error(),
				})
			}

			// Set org context
			SetOrgID(c, user.OrgID)
			c.Set("user_id", user.ID)
			c.Set("user_email", user.Email)

			return next(c)
		}
	}
}

// WorkOSUser represents a validated WorkOS user.
type WorkOSUser struct {
	ID    uuid.UUID
	OrgID uuid.UUID
	Email string
	Name  string
}

// validateSession validates a WorkOS session token.
// In production, this calls the WorkOS API. For now, it's a placeholder.
func (w *WorkOSMiddleware) validateSession(ctx context.Context, token string) (*WorkOSUser, error) {
	// TODO: Implement actual WorkOS API call:
	// POST https://api.workos.com/user_management/sessions/authenticate
	// with { session_token: token, client_id: w.config.ClientID }
	// This returns user info including email, org membership, etc.
	_ = token
	return nil, fmt.Errorf("WorkOS session validation not yet implemented")
}

// ProvisionOrgAndUser creates or fetches an org and user based on WorkOS data.
// Called on first login to auto-provision local records.
func (w *WorkOSMiddleware) ProvisionOrgAndUser(ctx context.Context, email, name, orgName string) (*WorkOSUser, error) {
	if w.store == nil {
		return nil, fmt.Errorf("database not configured")
	}

	// Check if user exists
	existingUser, err := w.store.GetUserByEmail(ctx, email)
	if err == nil {
		return &WorkOSUser{
			ID:    existingUser.ID,
			OrgID: existingUser.OrgID,
			Email: existingUser.Email,
			Name:  existingUser.Name,
		}, nil
	}

	// Create org (slug from org name)
	slug := strings.ToLower(strings.ReplaceAll(orgName, " ", "-"))
	org, err := w.store.GetOrgBySlug(ctx, slug)
	if err != nil {
		org, err = w.store.CreateOrg(ctx, orgName, slug)
		if err != nil {
			return nil, fmt.Errorf("failed to create org: %w", err)
		}
		log.Printf("workos: provisioned new org: %s (%s)", org.Name, org.ID)

		// Generate a default API key for the new org
		apiKey, err := GenerateAPIKey()
		if err == nil {
			hash := db.HashAPIKey(apiKey)
			prefix := apiKey[:8]
			_, _ = w.store.CreateAPIKey(ctx, org.ID, nil, hash, prefix, "Default", []string{"sandbox:*"})
			log.Printf("workos: created default API key for org %s: %s...", org.Slug, prefix)
		}
	}

	// Create user
	user, err := w.store.CreateUser(ctx, org.ID, email, name, "admin")
	if err != nil {
		return nil, fmt.Errorf("failed to create user: %w", err)
	}
	log.Printf("workos: provisioned new user: %s (%s)", user.Email, user.ID)

	return &WorkOSUser{
		ID:    user.ID,
		OrgID: user.OrgID,
		Email: user.Email,
		Name:  user.Name,
	}, nil
}

// GenerateAPIKey generates a new plaintext API key with the osb_ prefix.
func GenerateAPIKey() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return "osb_" + hex.EncodeToString(bytes), nil
}
