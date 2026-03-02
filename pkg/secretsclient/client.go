// Package secretsclient provides a Go-native gRPC client for the secrets service.
// Used by both the control plane and the worker.
package secretsclient

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"time"

	"github.com/google/uuid"
	pb "github.com/opensandbox/opensandbox/proto/secrets"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
)

// Secret is a Go-native representation of a secret (no encrypted value).
type Secret struct {
	ID          uuid.UUID
	OrgID       uuid.UUID
	Name        string
	Description string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// SecretGroup is a Go-native representation of a secret group.
type SecretGroup struct {
	ID           uuid.UUID
	OrgID        uuid.UUID
	Name         string
	Description  string
	AllowedHosts []string
	CreatedAt    time.Time
}

// SecretGroupEntry is a Go-native representation of a secret group entry.
type SecretGroupEntry struct {
	ID         uuid.UUID
	GroupID    uuid.UUID
	SecretID   uuid.UUID
	SecretName string
	EnvVarName string
}

// SecretGroupEntryInput is used when setting entries on a group.
type SecretGroupEntryInput struct {
	SecretID   uuid.UUID
	EnvVarName string
}

// ResolveResult holds the result of resolving a secret group.
type ResolveResult struct {
	EnvVars      map[string]string
	AllowedHosts []string
}

// SessionResult holds the result of creating a secret session.
type SessionResult struct {
	SessionID    string
	SessionToken string
	SealedTokens map[string]string // {envVarName: "osb_sealed_xxx"}
	AllowedHosts []string
	ExpiresAt    time.Time
}

// ResolveSessionResult holds the result of resolving a secret session.
type ResolveSessionResult struct {
	TokenValues  map[string]string // {"osb_sealed_xxx": "real-api-key"}
	AllowedHosts []string
}

// ClientOpts configures the secrets gRPC client.
type ClientOpts struct {
	// APIKey is sent in the "authorization" gRPC metadata header on every RPC.
	// Required when the secrets server has API key auth enabled.
	APIKey string

	// TLSCAFile is the path to a PEM-encoded CA certificate for verifying the
	// secrets server's TLS certificate. If empty and TLS is not skipped, the
	// system certificate pool is used.
	TLSCAFile string

	// TLSSkipVerify disables TLS certificate verification (dev/test only).
	TLSSkipVerify bool

	// Insecure disables TLS entirely (plaintext gRPC). For local dev only.
	Insecure bool
}

// apiKeyCreds implements grpc.PerRPCCredentials to inject the API key.
type apiKeyCreds struct {
	key string
}

func (c *apiKeyCreds) GetRequestMetadata(_ context.Context, _ ...string) (map[string]string, error) {
	return map[string]string{"authorization": c.key}, nil
}

func (c *apiKeyCreds) RequireTransportSecurity() bool {
	return false // we handle TLS separately; allow insecure for dev
}

// Client wraps the secrets gRPC client with Go-native types.
type Client struct {
	conn   *grpc.ClientConn
	client pb.SecretsServiceClient
}

// NewClient creates a new secrets gRPC client with optional TLS and API key auth.
func NewClient(addr string, opts *ClientOpts) (*Client, error) {
	if opts == nil {
		opts = &ClientOpts{Insecure: true}
	}

	var dialOpts []grpc.DialOption

	// Transport credentials
	if opts.Insecure {
		dialOpts = append(dialOpts, grpc.WithTransportCredentials(insecure.NewCredentials()))
	} else {
		tlsCfg := &tls.Config{}
		if opts.TLSSkipVerify {
			tlsCfg.InsecureSkipVerify = true
		} else if opts.TLSCAFile != "" {
			caPEM, err := os.ReadFile(opts.TLSCAFile)
			if err != nil {
				return nil, fmt.Errorf("read TLS CA file %s: %w", opts.TLSCAFile, err)
			}
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM(caPEM) {
				return nil, fmt.Errorf("failed to parse CA certificate from %s", opts.TLSCAFile)
			}
			tlsCfg.RootCAs = pool
		}
		dialOpts = append(dialOpts, grpc.WithTransportCredentials(credentials.NewTLS(tlsCfg)))
	}

	// Per-RPC API key
	if opts.APIKey != "" {
		dialOpts = append(dialOpts, grpc.WithPerRPCCredentials(&apiKeyCreds{key: opts.APIKey}))
	}

	conn, err := grpc.NewClient(addr, dialOpts...)
	if err != nil {
		return nil, fmt.Errorf("connect to secrets service at %s: %w", addr, err)
	}
	return &Client{
		conn:   conn,
		client: pb.NewSecretsServiceClient(conn),
	}, nil
}

// Close closes the gRPC connection.
func (c *Client) Close() error {
	return c.conn.Close()
}

// --- helpers ---

func secretFromProto(s *pb.Secret) *Secret {
	return &Secret{
		ID:          uuid.MustParse(s.Id),
		OrgID:       uuid.MustParse(s.OrgId),
		Name:        s.Name,
		Description: s.Description,
		CreatedAt:   time.Unix(s.CreatedAt, 0),
		UpdatedAt:   time.Unix(s.UpdatedAt, 0),
	}
}

func groupFromProto(g *pb.SecretGroup) *SecretGroup {
	return &SecretGroup{
		ID:           uuid.MustParse(g.Id),
		OrgID:        uuid.MustParse(g.OrgId),
		Name:         g.Name,
		Description:  g.Description,
		AllowedHosts: g.AllowedHosts,
		CreatedAt:    time.Unix(g.CreatedAt, 0),
	}
}

func entryFromProto(e *pb.SecretGroupEntry) *SecretGroupEntry {
	return &SecretGroupEntry{
		ID:         uuid.MustParse(e.Id),
		GroupID:    uuid.MustParse(e.GroupId),
		SecretID:   uuid.MustParse(e.SecretId),
		SecretName: e.SecretName,
		EnvVarName: e.EnvVarName,
	}
}

// --- Secret CRUD ---

func (c *Client) CreateSecret(ctx context.Context, orgID uuid.UUID, name, description, plaintextValue string) (*Secret, error) {
	resp, err := c.client.CreateSecret(ctx, &pb.CreateSecretRequest{
		OrgId:          orgID.String(),
		Name:           name,
		Description:    description,
		PlaintextValue: plaintextValue,
	})
	if err != nil {
		return nil, err
	}
	return secretFromProto(resp.Secret), nil
}

func (c *Client) ListSecrets(ctx context.Context, orgID uuid.UUID) ([]Secret, error) {
	resp, err := c.client.ListSecrets(ctx, &pb.ListSecretsRequest{
		OrgId: orgID.String(),
	})
	if err != nil {
		return nil, err
	}
	secrets := make([]Secret, 0, len(resp.Secrets))
	for _, s := range resp.Secrets {
		secrets = append(secrets, *secretFromProto(s))
	}
	return secrets, nil
}

func (c *Client) UpdateSecret(ctx context.Context, orgID, secretID uuid.UUID, name, description string, newValue *string) error {
	req := &pb.UpdateSecretRequest{
		OrgId:       orgID.String(),
		SecretId:    secretID.String(),
		Name:        name,
		Description: description,
	}
	if newValue != nil {
		req.NewValue = newValue
	}
	_, err := c.client.UpdateSecret(ctx, req)
	return err
}

func (c *Client) DeleteSecret(ctx context.Context, orgID, secretID uuid.UUID) error {
	_, err := c.client.DeleteSecret(ctx, &pb.DeleteSecretRequest{
		OrgId:    orgID.String(),
		SecretId: secretID.String(),
	})
	return err
}

// --- Secret Group CRUD ---

func (c *Client) CreateSecretGroup(ctx context.Context, orgID uuid.UUID, name, description string, allowedHosts []string) (*SecretGroup, error) {
	resp, err := c.client.CreateSecretGroup(ctx, &pb.CreateSecretGroupRequest{
		OrgId:        orgID.String(),
		Name:         name,
		Description:  description,
		AllowedHosts: allowedHosts,
	})
	if err != nil {
		return nil, err
	}
	return groupFromProto(resp.Group), nil
}

func (c *Client) ListSecretGroups(ctx context.Context, orgID uuid.UUID) ([]SecretGroup, error) {
	resp, err := c.client.ListSecretGroups(ctx, &pb.ListSecretGroupsRequest{
		OrgId: orgID.String(),
	})
	if err != nil {
		return nil, err
	}
	groups := make([]SecretGroup, 0, len(resp.Groups))
	for _, g := range resp.Groups {
		groups = append(groups, *groupFromProto(g))
	}
	return groups, nil
}

func (c *Client) GetSecretGroup(ctx context.Context, orgID, groupID uuid.UUID) (*SecretGroup, error) {
	resp, err := c.client.GetSecretGroup(ctx, &pb.GetSecretGroupRequest{
		OrgId:   orgID.String(),
		GroupId: groupID.String(),
	})
	if err != nil {
		return nil, err
	}
	return groupFromProto(resp.Group), nil
}

func (c *Client) UpdateSecretGroup(ctx context.Context, orgID, groupID uuid.UUID, name, description string, allowedHosts []string) error {
	_, err := c.client.UpdateSecretGroup(ctx, &pb.UpdateSecretGroupRequest{
		OrgId:        orgID.String(),
		GroupId:      groupID.String(),
		Name:         name,
		Description:  description,
		AllowedHosts: allowedHosts,
	})
	return err
}

func (c *Client) DeleteSecretGroup(ctx context.Context, orgID, groupID uuid.UUID) error {
	_, err := c.client.DeleteSecretGroup(ctx, &pb.DeleteSecretGroupRequest{
		OrgId:   orgID.String(),
		GroupId: groupID.String(),
	})
	return err
}

// --- Secret Group Entries ---

func (c *Client) SetSecretGroupEntries(ctx context.Context, groupID uuid.UUID, entries []SecretGroupEntryInput) error {
	pbEntries := make([]*pb.SecretGroupEntryInput, 0, len(entries))
	for _, e := range entries {
		pbEntries = append(pbEntries, &pb.SecretGroupEntryInput{
			SecretId:   e.SecretID.String(),
			EnvVarName: e.EnvVarName,
		})
	}
	_, err := c.client.SetSecretGroupEntries(ctx, &pb.SetSecretGroupEntriesRequest{
		GroupId: groupID.String(),
		Entries: pbEntries,
	})
	return err
}

func (c *Client) GetSecretGroupEntries(ctx context.Context, groupID uuid.UUID) ([]SecretGroupEntry, error) {
	resp, err := c.client.GetSecretGroupEntries(ctx, &pb.GetSecretGroupEntriesRequest{
		GroupId: groupID.String(),
	})
	if err != nil {
		return nil, err
	}
	entries := make([]SecretGroupEntry, 0, len(resp.Entries))
	for _, e := range resp.Entries {
		entries = append(entries, *entryFromProto(e))
	}
	return entries, nil
}

// --- Resolve ---

func (c *Client) ResolveSecretGroup(ctx context.Context, orgID, groupID uuid.UUID) (*ResolveResult, error) {
	resp, err := c.client.ResolveSecretGroup(ctx, &pb.ResolveSecretGroupRequest{
		GroupId: groupID.String(),
		OrgId:   orgID.String(),
	})
	if err != nil {
		return nil, err
	}
	return &ResolveResult{
		EnvVars:      resp.EnvVars,
		AllowedHosts: resp.AllowedHosts,
	}, nil
}

// --- Secret Sessions ---

func (c *Client) CreateSecretSession(ctx context.Context, orgID uuid.UUID, groupID uuid.UUID, sandboxID string, ttlSeconds int32) (*SessionResult, error) {
	resp, err := c.client.CreateSecretSession(ctx, &pb.CreateSecretSessionRequest{
		OrgId:      orgID.String(),
		GroupId:    groupID.String(),
		SandboxId:  sandboxID,
		TtlSeconds: ttlSeconds,
	})
	if err != nil {
		return nil, err
	}
	return &SessionResult{
		SessionID:    resp.SessionId,
		SessionToken: resp.SessionToken,
		SealedTokens: resp.SealedTokens,
		AllowedHosts: resp.AllowedHosts,
		ExpiresAt:    time.Unix(resp.ExpiresAt, 0),
	}, nil
}

func (c *Client) ResolveSecretSession(ctx context.Context, sessionID, sessionToken string) (*ResolveSessionResult, error) {
	resp, err := c.client.ResolveSecretSession(ctx, &pb.ResolveSecretSessionRequest{
		SessionId:    sessionID,
		SessionToken: sessionToken,
	})
	if err != nil {
		return nil, err
	}
	return &ResolveSessionResult{
		TokenValues:  resp.TokenValues,
		AllowedHosts: resp.AllowedHosts,
	}, nil
}

func (c *Client) DeleteSecretSession(ctx context.Context, sessionID string) error {
	_, err := c.client.DeleteSecretSession(ctx, &pb.DeleteSecretSessionRequest{
		SessionId: sessionID,
	})
	return err
}
