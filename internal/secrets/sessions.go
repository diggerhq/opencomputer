package secrets

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
)

const defaultSessionTTL = 24 * time.Hour

// SecretSession holds a resolved secret group for a single sandbox.
// Stored server-side — the control plane only receives sealed tokens.
type SecretSession struct {
	ID           string
	OrgID        uuid.UUID
	SandboxID    string
	TokenHash    [32]byte          // SHA-256 of the bearer token
	SealedTokens map[string]string // {envVarName: "osb_sealed_xxx"}
	TokenValues  map[string]string // {"osb_sealed_xxx": realValue}
	AllowedHosts []string
	ExpiresAt    time.Time
	CreatedAt    time.Time
}

// SessionStore is an in-memory store for secret sessions.
// Can be replaced with Redis for distributed deployments.
type SessionStore struct {
	mu       sync.RWMutex
	sessions map[string]*SecretSession // session ID → session
}

// NewSessionStore creates a new in-memory session store.
func NewSessionStore() *SessionStore {
	ss := &SessionStore{
		sessions: make(map[string]*SecretSession),
	}
	go ss.cleanupLoop()
	return ss
}

// Create stores a new session and returns it.
func (ss *SessionStore) Create(session *SecretSession) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	ss.sessions[session.ID] = session
}

// Get retrieves a session by ID. Returns nil if not found or expired.
func (ss *SessionStore) Get(id string) *SecretSession {
	ss.mu.RLock()
	defer ss.mu.RUnlock()
	s, ok := ss.sessions[id]
	if !ok {
		return nil
	}
	if time.Now().After(s.ExpiresAt) {
		return nil
	}
	return s
}

// Delete removes a session by ID.
func (ss *SessionStore) Delete(id string) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	delete(ss.sessions, id)
}

// cleanupLoop periodically removes expired sessions.
func (ss *SessionStore) cleanupLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		ss.mu.Lock()
		now := time.Now()
		for id, s := range ss.sessions {
			if now.After(s.ExpiresAt) {
				delete(ss.sessions, id)
			}
		}
		ss.mu.Unlock()
	}
}

// generateSessionToken creates a cryptographically random 32-byte hex token.
func generateSessionToken() (string, [32]byte, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", [32]byte{}, fmt.Errorf("generate session token: %w", err)
	}
	token := hex.EncodeToString(b)
	hash := sha256.Sum256([]byte(token))
	return token, hash, nil
}

// generateSealedToken creates a sealed token string for one env var.
func generateSealedToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return "osb_sealed_" + hex.EncodeToString(b)
}

// ValidateSessionToken compares a provided token against the stored hash.
func ValidateSessionToken(provided string, storedHash [32]byte) bool {
	h := sha256.Sum256([]byte(provided))
	return hmac.Equal(h[:], storedHash[:])
}
