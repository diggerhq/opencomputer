package secrets

import (
	"context"
	"log"
	"time"

	"github.com/google/uuid"
	pb "github.com/opensandbox/opensandbox/proto/secrets"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Server implements the SecretsService gRPC service.
type Server struct {
	pb.UnimplementedSecretsServiceServer
	store    *Store
	sessions *SessionStore
}

// NewServer creates a new secrets gRPC server.
func NewServer(store *Store) *Server {
	return &Server{
		store:    store,
		sessions: NewSessionStore(),
	}
}

// --- helpers ---

func parseUUID(s, field string) (uuid.UUID, error) {
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil, status.Errorf(codes.InvalidArgument, "invalid %s: %v", field, err)
	}
	return id, nil
}

func secretToProto(s *Secret) *pb.Secret {
	return &pb.Secret{
		Id:          s.ID.String(),
		OrgId:       s.OrgID.String(),
		Name:        s.Name,
		Description: s.Description,
		CreatedAt:   s.CreatedAt.Unix(),
		UpdatedAt:   s.UpdatedAt.Unix(),
	}
}

func groupToProto(g *SecretGroup) *pb.SecretGroup {
	return &pb.SecretGroup{
		Id:           g.ID.String(),
		OrgId:        g.OrgID.String(),
		Name:         g.Name,
		Description:  g.Description,
		AllowedHosts: g.AllowedHosts,
		CreatedAt:    g.CreatedAt.Unix(),
	}
}

func entryToProto(e *SecretGroupEntry) *pb.SecretGroupEntry {
	return &pb.SecretGroupEntry{
		Id:         e.ID.String(),
		GroupId:    e.GroupID.String(),
		SecretId:   e.SecretID.String(),
		SecretName: e.SecretName,
		EnvVarName: e.EnvVarName,
	}
}

// --- Secret CRUD ---

func (s *Server) CreateSecret(ctx context.Context, req *pb.CreateSecretRequest) (*pb.CreateSecretResponse, error) {
	orgID, err := parseUUID(req.OrgId, "org_id")
	if err != nil {
		return nil, err
	}
	if req.Name == "" {
		return nil, status.Error(codes.InvalidArgument, "name is required")
	}

	secret, err := s.store.CreateSecret(ctx, orgID, req.Name, req.Description, req.PlaintextValue)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "create secret: %v", err)
	}
	return &pb.CreateSecretResponse{Secret: secretToProto(secret)}, nil
}

func (s *Server) ListSecrets(ctx context.Context, req *pb.ListSecretsRequest) (*pb.ListSecretsResponse, error) {
	orgID, err := parseUUID(req.OrgId, "org_id")
	if err != nil {
		return nil, err
	}

	secrets, err := s.store.ListSecrets(ctx, orgID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "list secrets: %v", err)
	}

	resp := &pb.ListSecretsResponse{}
	for i := range secrets {
		resp.Secrets = append(resp.Secrets, secretToProto(&secrets[i]))
	}
	return resp, nil
}

func (s *Server) UpdateSecret(ctx context.Context, req *pb.UpdateSecretRequest) (*pb.UpdateSecretResponse, error) {
	orgID, err := parseUUID(req.OrgId, "org_id")
	if err != nil {
		return nil, err
	}
	secretID, err := parseUUID(req.SecretId, "secret_id")
	if err != nil {
		return nil, err
	}

	var newValue *string
	if req.NewValue != nil {
		v := *req.NewValue
		newValue = &v
	}

	if err := s.store.UpdateSecret(ctx, orgID, secretID, req.Name, req.Description, newValue); err != nil {
		return nil, status.Errorf(codes.Internal, "update secret: %v", err)
	}
	return &pb.UpdateSecretResponse{}, nil
}

func (s *Server) DeleteSecret(ctx context.Context, req *pb.DeleteSecretRequest) (*pb.DeleteSecretResponse, error) {
	orgID, err := parseUUID(req.OrgId, "org_id")
	if err != nil {
		return nil, err
	}
	secretID, err := parseUUID(req.SecretId, "secret_id")
	if err != nil {
		return nil, err
	}

	if err := s.store.DeleteSecret(ctx, orgID, secretID); err != nil {
		return nil, status.Errorf(codes.Internal, "delete secret: %v", err)
	}
	return &pb.DeleteSecretResponse{}, nil
}

// --- Secret Group CRUD ---

func (s *Server) CreateSecretGroup(ctx context.Context, req *pb.CreateSecretGroupRequest) (*pb.CreateSecretGroupResponse, error) {
	orgID, err := parseUUID(req.OrgId, "org_id")
	if err != nil {
		return nil, err
	}
	if req.Name == "" {
		return nil, status.Error(codes.InvalidArgument, "name is required")
	}

	group, err := s.store.CreateSecretGroup(ctx, orgID, req.Name, req.Description, req.AllowedHosts)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "create secret group: %v", err)
	}
	return &pb.CreateSecretGroupResponse{Group: groupToProto(group)}, nil
}

func (s *Server) ListSecretGroups(ctx context.Context, req *pb.ListSecretGroupsRequest) (*pb.ListSecretGroupsResponse, error) {
	orgID, err := parseUUID(req.OrgId, "org_id")
	if err != nil {
		return nil, err
	}

	groups, err := s.store.ListSecretGroups(ctx, orgID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "list secret groups: %v", err)
	}

	resp := &pb.ListSecretGroupsResponse{}
	for i := range groups {
		resp.Groups = append(resp.Groups, groupToProto(&groups[i]))
	}
	return resp, nil
}

func (s *Server) GetSecretGroup(ctx context.Context, req *pb.GetSecretGroupRequest) (*pb.GetSecretGroupResponse, error) {
	orgID, err := parseUUID(req.OrgId, "org_id")
	if err != nil {
		return nil, err
	}
	groupID, err := parseUUID(req.GroupId, "group_id")
	if err != nil {
		return nil, err
	}

	group, err := s.store.GetSecretGroup(ctx, orgID, groupID)
	if err != nil {
		return nil, status.Errorf(codes.NotFound, "get secret group: %v", err)
	}
	return &pb.GetSecretGroupResponse{Group: groupToProto(group)}, nil
}

func (s *Server) UpdateSecretGroup(ctx context.Context, req *pb.UpdateSecretGroupRequest) (*pb.UpdateSecretGroupResponse, error) {
	orgID, err := parseUUID(req.OrgId, "org_id")
	if err != nil {
		return nil, err
	}
	groupID, err := parseUUID(req.GroupId, "group_id")
	if err != nil {
		return nil, err
	}

	if err := s.store.UpdateSecretGroup(ctx, orgID, groupID, req.Name, req.Description, req.AllowedHosts); err != nil {
		return nil, status.Errorf(codes.Internal, "update secret group: %v", err)
	}
	return &pb.UpdateSecretGroupResponse{}, nil
}

func (s *Server) DeleteSecretGroup(ctx context.Context, req *pb.DeleteSecretGroupRequest) (*pb.DeleteSecretGroupResponse, error) {
	orgID, err := parseUUID(req.OrgId, "org_id")
	if err != nil {
		return nil, err
	}
	groupID, err := parseUUID(req.GroupId, "group_id")
	if err != nil {
		return nil, err
	}

	if err := s.store.DeleteSecretGroup(ctx, orgID, groupID); err != nil {
		return nil, status.Errorf(codes.Internal, "delete secret group: %v", err)
	}
	return &pb.DeleteSecretGroupResponse{}, nil
}

// --- Secret Group Entries ---

func (s *Server) SetSecretGroupEntries(ctx context.Context, req *pb.SetSecretGroupEntriesRequest) (*pb.SetSecretGroupEntriesResponse, error) {
	groupID, err := parseUUID(req.GroupId, "group_id")
	if err != nil {
		return nil, err
	}

	entries := make([]SecretGroupEntryInput, 0, len(req.Entries))
	for _, e := range req.Entries {
		secID, err := parseUUID(e.SecretId, "secret_id")
		if err != nil {
			return nil, err
		}
		entries = append(entries, SecretGroupEntryInput{
			SecretID:   secID,
			EnvVarName: e.EnvVarName,
		})
	}

	if err := s.store.SetSecretGroupEntries(ctx, groupID, entries); err != nil {
		return nil, status.Errorf(codes.Internal, "set entries: %v", err)
	}
	return &pb.SetSecretGroupEntriesResponse{}, nil
}

func (s *Server) GetSecretGroupEntries(ctx context.Context, req *pb.GetSecretGroupEntriesRequest) (*pb.GetSecretGroupEntriesResponse, error) {
	groupID, err := parseUUID(req.GroupId, "group_id")
	if err != nil {
		return nil, err
	}

	entries, err := s.store.GetSecretGroupEntries(ctx, groupID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "get entries: %v", err)
	}

	resp := &pb.GetSecretGroupEntriesResponse{}
	for i := range entries {
		resp.Entries = append(resp.Entries, entryToProto(&entries[i]))
	}
	return resp, nil
}

// --- Resolve ---

func (s *Server) ResolveSecretGroup(ctx context.Context, req *pb.ResolveSecretGroupRequest) (*pb.ResolveSecretGroupResponse, error) {
	groupID, err := parseUUID(req.GroupId, "group_id")
	if err != nil {
		return nil, err
	}
	orgID, err := parseUUID(req.OrgId, "org_id")
	if err != nil {
		return nil, err
	}

	// Validate the group belongs to the requesting org before resolving
	group, err := s.store.GetSecretGroup(ctx, orgID, groupID)
	if err != nil || group == nil {
		return nil, status.Errorf(codes.NotFound, "secret group not found or not owned by org")
	}

	envVars, allowedHosts, err := s.store.ResolveSecretGroup(ctx, groupID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "resolve secret group: %v", err)
	}

	return &pb.ResolveSecretGroupResponse{
		EnvVars:      envVars,
		AllowedHosts: allowedHosts,
	}, nil
}

// --- Secret Sessions ---

func (s *Server) CreateSecretSession(ctx context.Context, req *pb.CreateSecretSessionRequest) (*pb.CreateSecretSessionResponse, error) {
	orgID, err := parseUUID(req.OrgId, "org_id")
	if err != nil {
		return nil, err
	}
	groupID, err := parseUUID(req.GroupId, "group_id")
	if err != nil {
		return nil, err
	}
	if req.SandboxId == "" {
		return nil, status.Error(codes.InvalidArgument, "sandbox_id is required")
	}

	// Validate org ownership
	group, err := s.store.GetSecretGroup(ctx, orgID, groupID)
	if err != nil || group == nil {
		return nil, status.Errorf(codes.NotFound, "secret group not found or not owned by org")
	}

	// Resolve secrets (plaintext stays server-side)
	envVars, allowedHosts, err := s.store.ResolveSecretGroup(ctx, groupID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "resolve secret group: %v", err)
	}

	// Generate session token
	token, tokenHash, err := generateSessionToken()
	if err != nil {
		return nil, status.Errorf(codes.Internal, "generate session token: %v", err)
	}

	// Generate sealed tokens — one per env var
	sealedTokens := make(map[string]string, len(envVars))
	tokenValues := make(map[string]string, len(envVars))
	for envVar, realValue := range envVars {
		sealed := generateSealedToken()
		sealedTokens[envVar] = sealed
		tokenValues[sealed] = realValue
	}

	ttl := defaultSessionTTL
	if req.TtlSeconds > 0 {
		ttl = time.Duration(req.TtlSeconds) * time.Second
	}
	expiresAt := time.Now().Add(ttl)

	sessionID := uuid.New().String()
	session := &SecretSession{
		ID:           sessionID,
		OrgID:        orgID,
		SandboxID:    req.SandboxId,
		TokenHash:    tokenHash,
		SealedTokens: sealedTokens,
		TokenValues:  tokenValues,
		AllowedHosts: allowedHosts,
		ExpiresAt:    expiresAt,
		CreatedAt:    time.Now(),
	}
	s.sessions.Create(session)

	log.Printf("secrets-server: created session %s for sandbox %s (vars=%d, ttl=%s)",
		sessionID, req.SandboxId, len(envVars), ttl)

	return &pb.CreateSecretSessionResponse{
		SessionId:    sessionID,
		SessionToken: token,
		SealedTokens: sealedTokens,
		AllowedHosts: allowedHosts,
		ExpiresAt:    expiresAt.Unix(),
	}, nil
}

func (s *Server) ResolveSecretSession(ctx context.Context, req *pb.ResolveSecretSessionRequest) (*pb.ResolveSecretSessionResponse, error) {
	if req.SessionId == "" || req.SessionToken == "" {
		return nil, status.Error(codes.InvalidArgument, "session_id and session_token are required")
	}

	session := s.sessions.Get(req.SessionId)
	if session == nil {
		return nil, status.Error(codes.NotFound, "session not found or expired")
	}

	if !ValidateSessionToken(req.SessionToken, session.TokenHash) {
		return nil, status.Error(codes.Unauthenticated, "invalid session token")
	}

	log.Printf("secrets-server: resolved session %s for sandbox %s (vars=%d)",
		req.SessionId, session.SandboxID, len(session.TokenValues))

	return &pb.ResolveSecretSessionResponse{
		TokenValues:  session.TokenValues,
		AllowedHosts: session.AllowedHosts,
	}, nil
}

func (s *Server) DeleteSecretSession(ctx context.Context, req *pb.DeleteSecretSessionRequest) (*pb.DeleteSecretSessionResponse, error) {
	if req.SessionId == "" {
		return nil, status.Error(codes.InvalidArgument, "session_id is required")
	}

	s.sessions.Delete(req.SessionId)
	log.Printf("secrets-server: deleted session %s", req.SessionId)

	return &pb.DeleteSecretSessionResponse{}, nil
}

// Ensure Server implements the interface at compile time.
var _ pb.SecretsServiceServer = (*Server)(nil)
