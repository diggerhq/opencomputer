package api

import (
	"context"
	"errors"
	"net/http"
	"sort"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/internal/auth"
	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/internal/edgeclient"
)

// AllowedHostsResponse is the shape returned by GET /api/sandboxes/:id/allowed-hosts.
//
// EgressAllowlist + PerSecretAllowedHosts represent the runtime view — the
// union of every layered store's allowlist, exactly as the secrets proxy
// enforces it. Most sandboxes have a single store and the union is trivially
// that one store's allowlist; forks that layer an additional store on top of
// an inherited one have BOTH stores' allowlists merged here.
//
// SecretStoreName is the "primary" (last/winning) store on the sandbox row —
// the one whose secrets shadow the base store on env-name collisions.
// BaseSecretStoreName is the inherited parent store from the fork chain;
// populated only when there's actual layering. Both empty = sandbox created
// without a secretStore (no per-store egress restriction enforced).
//
// SecretEnvNames lists the environment variable names the attached store(s)
// inject into the sandbox. Names only — values are never returned.
type AllowedHostsResponse struct {
	SandboxID             string              `json:"sandboxID"`
	SecretStoreName       string              `json:"secretStore,omitempty"`
	BaseSecretStoreName   string              `json:"baseSecretStore,omitempty"`
	SecretEnvNames        []string            `json:"secretEnvNames"`
	EgressAllowlist       []string            `json:"egressAllowlist"`
	PerSecretAllowedHosts map[string][]string `json:"perSecretAllowedHosts"`
}

func newAllowedHostsResponse(sandboxID string) *AllowedHostsResponse {
	return &AllowedHostsResponse{
		SandboxID:             sandboxID,
		SecretEnvNames:        []string{},
		EgressAllowlist:       []string{},
		PerSecretAllowedHosts: map[string][]string{},
	}
}

// getSandboxAllowedHosts handles GET /api/sandboxes/:id/allowed-hosts.
//
// Returns the egress allowlist + per-secret allowed hosts the sandbox's
// secrets proxy enforces. Useful for debugging "why is my outbound HTTP call
// being blocked" without having to cross-reference store config separately.
//
// For forks that layered a new secretStore on top of an inherited one, the
// response merges both stores' allowlists — the runtime proxy enforces the
// union, so this matches actual behavior. The primary store's secrets shadow
// the base store on env-name collisions.
//
// Auth: same as other /api/sandboxes/:id routes — PGAPIKeyMiddleware sets
// orgID on the context. Sandbox lookup is org-scoped to prevent cross-tenant
// reads via guessed sandbox IDs.
func (s *Server) getSandboxAllowedHosts(c echo.Context) error {
	if s.store == nil {
		return c.JSON(http.StatusServiceUnavailable, errSandboxNotAvailable)
	}

	orgID, hasOrg := auth.GetOrgID(c)
	if !hasOrg {
		return c.JSON(http.StatusUnauthorized, map[string]string{"error": "auth required"})
	}

	resp, status, err := s.sandboxSecretsView(c.Request().Context(), orgID, c.Param("id"))
	if err != nil {
		return c.JSON(status, map[string]string{"error": err.Error()})
	}
	return c.JSON(http.StatusOK, resp)
}

// sandboxSecretsView builds the org-scoped, value-free view of what secret
// store(s) a sandbox has attached: store names, the env var names they
// inject, and the host restrictions the proxy enforces. Shared by the public
// allowed-hosts route and the dashboard session detail. On error the returned
// status is the HTTP status the caller should respond with.
func (s *Server) sandboxSecretsView(ctx context.Context, orgID uuid.UUID, sandboxID string) (*AllowedHostsResponse, int, error) {
	primaryID, primaryName, baseStoreName, err := s.store.GetSandboxStoreRefs(ctx, orgID, sandboxID)
	if err != nil {
		return nil, http.StatusNotFound, errors.New("sandbox not found")
	}

	resp := newAllowedHostsResponse(sandboxID)

	// Sandbox has neither a primary store nor an inherited base. Return an
	// empty (well-formed) response so callers always see the same shape.
	if primaryID == nil && primaryName == "" && baseStoreName == "" {
		return resp, http.StatusOK, nil
	}

	useEdge := s.edge != nil && s.store.Encryptor() != nil

	// Fetch base store first so primary's per-secret entries can shadow on
	// name collision (matches the runtime proxy: later layer wins for envs).
	if baseStoreName != "" {
		if useEdge {
			base, err := s.edge.LookupSecretStore(ctx, orgID, baseStoreName, s.store.Encryptor())
			if err == nil {
				resp.BaseSecretStoreName = base.Store.Name
				mergeSecretBundleInto(base, resp)
			} else if !errors.Is(err, edgeclient.ErrNotFound) {
				return nil, http.StatusBadGateway, err
			}
		} else {
			base, err := s.store.GetSecretStoreByName(ctx, orgID, baseStoreName)
			if err == nil {
				resp.BaseSecretStoreName = base.Name
				mergeStoreInto(ctx, s.store, base, resp)
			}
		}
		// Base store missing (deleted under us) is treated as a soft no-op
		// rather than 500 — proxy already snapshotted whatever it needs.
	}

	if useEdge {
		if primaryID != nil {
			primary, err := s.edge.LookupSecretStoreByID(ctx, *primaryID, s.store.Encryptor())
			if err == nil {
				resp.SecretStoreName = primary.Store.Name
				mergeSecretBundleInto(primary, resp)
				return resp, http.StatusOK, nil
			} else if !errors.Is(err, edgeclient.ErrNotFound) {
				return nil, http.StatusBadGateway, err
			}
		}
		if primaryName != "" {
			primary, err := s.edge.LookupSecretStore(ctx, orgID, primaryName, s.store.Encryptor())
			if err == nil {
				resp.SecretStoreName = primary.Store.Name
				mergeSecretBundleInto(primary, resp)
			} else if !errors.Is(err, edgeclient.ErrNotFound) {
				return nil, http.StatusBadGateway, err
			}
		}
	} else if primaryID != nil {
		primary, err := s.store.GetSecretStore(ctx, orgID, *primaryID)
		if err == nil {
			resp.SecretStoreName = primary.Name
			mergeStoreInto(ctx, s.store, primary, resp)
		}
	}

	return resp, http.StatusOK, nil
}

// mergeStoreInto folds one store's allowlist + per-secret restrictions into
// the running response. Egress hosts dedupe (preserving insertion order so
// base-store hosts appear before primary's additions). Per-secret entries
// with empty AllowedHosts are skipped — empty means "inherits store
// allowlist," and surfacing them as [] would falsely imply "no hosts allowed
// for this secret." Per-secret name collisions are last-write-wins, so the
// primary store (called second) shadows the base.
func mergeStoreInto(ctx context.Context, store *db.Store, ss *db.SecretStore, resp *AllowedHostsResponse) {
	mergeEgressHosts(ss.EgressAllowlist, resp)

	entries, err := store.ListSecretEntries(ctx, ss.ID)
	if err != nil {
		return
	}
	for _, e := range entries {
		mergeSecretEntry(e.Name, e.AllowedHosts, resp)
	}
}

func mergeSecretBundleInto(bundle *edgeclient.SecretStoreBundle, resp *AllowedHostsResponse) {
	mergeEgressHosts(bundle.Store.EgressAllowlist, resp)
	for _, e := range bundle.Entries {
		mergeSecretEntry(e.Name, e.AllowedHosts, resp)
	}
}

func mergeEgressHosts(hosts []string, resp *AllowedHostsResponse) {
	existing := make(map[string]bool, len(resp.EgressAllowlist))
	for _, h := range resp.EgressAllowlist {
		existing[h] = true
	}
	for _, h := range hosts {
		if !existing[h] {
			existing[h] = true
			resp.EgressAllowlist = append(resp.EgressAllowlist, h)
		}
	}
}

// mergeSecretEntry records the env name (deduped, kept sorted) and, when the
// entry carries its own host restriction, its allowed hosts.
func mergeSecretEntry(name string, allowedHosts []string, resp *AllowedHostsResponse) {
	i := sort.SearchStrings(resp.SecretEnvNames, name)
	if i == len(resp.SecretEnvNames) || resp.SecretEnvNames[i] != name {
		resp.SecretEnvNames = append(resp.SecretEnvNames, "")
		copy(resp.SecretEnvNames[i+1:], resp.SecretEnvNames[i:])
		resp.SecretEnvNames[i] = name
	}
	if len(allowedHosts) == 0 {
		return
	}
	resp.PerSecretAllowedHosts[name] = allowedHosts
}
