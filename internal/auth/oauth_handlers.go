package auth

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/workos/workos-go/v4/pkg/usermanagement"

	"github.com/opensandbox/opensandbox/internal/metrics"
)

// authType label values for opensandbox_auth_attempts_total. The type
// column groups by entry point (WorkOS callback today; add more on demand).
// Result is the binary outcome — success when the session cookie is set,
// failure for any earlier error return. Sub-reasons live in logs, not in
// metric labels, to keep label cardinality bounded.
const authTypeWorkOS = "workos"

// OAuthHandlers provides HTTP handlers for WorkOS OAuth flow.
type OAuthHandlers struct {
	workos *WorkOSMiddleware
}

// NewOAuthHandlers creates new OAuth handlers.
//
// Pre-warms the auth_attempts_total counter for both known result values so
// the dashboard panel renders 0 instead of "field not found" before any login
// has happened. Add(0) materializes the time series at zero without affecting
// the count once real attempts arrive.
func NewOAuthHandlers(workos *WorkOSMiddleware) *OAuthHandlers {
	metrics.AuthAttemptsTotal.WithLabelValues(authTypeWorkOS, "success").Add(0)
	metrics.AuthAttemptsTotal.WithLabelValues(authTypeWorkOS, "failure").Add(0)
	return &OAuthHandlers{workos: workos}
}

// HandleLogin redirects the user to WorkOS AuthKit for authentication.
func (h *OAuthHandlers) HandleLogin(c echo.Context) error {
	cfg := h.workos.Config()

	state, err := generateState()
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to generate state",
		})
	}

	// Store state in cookie for CSRF protection
	c.SetCookie(&http.Cookie{
		Name:     "oauth_state",
		Value:    state,
		Path:     "/",
		MaxAge:   600,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})

	authURL, err := h.workos.UserMgr().GetAuthorizationURL(usermanagement.GetAuthorizationURLOpts{
		ClientID:    cfg.ClientID,
		RedirectURI: cfg.RedirectURI,
		Provider:    "authkit",
		State:       state,
	})
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to generate authorization URL: " + err.Error(),
		})
	}

	return c.Redirect(http.StatusFound, authURL.String())
}

// HandleCallback exchanges the authorization code for user info and sets session cookie.
func (h *OAuthHandlers) HandleCallback(c echo.Context) error {
	code := c.QueryParam("code")
	state := c.QueryParam("state")

	if code == "" {
		metrics.AuthAttemptsTotal.WithLabelValues(authTypeWorkOS, "failure").Inc()
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "missing authorization code",
		})
	}

	// Verify CSRF state — only when the user started from /auth/login (which sets the cookie).
	// Invitation flows bypass login, so the user arrives with a code but no state/cookie.
	stateCookie, err := c.Cookie("oauth_state")
	if err == nil {
		// Cookie exists — verify it matches (normal login flow)
		if stateCookie.Value != state {
			metrics.AuthAttemptsTotal.WithLabelValues(authTypeWorkOS, "failure").Inc()
			return c.JSON(http.StatusBadRequest, map[string]string{
				"error": "invalid state parameter",
			})
		}
		// Clear state cookie
		c.SetCookie(&http.Cookie{
			Name:   "oauth_state",
			Value:  "",
			Path:   "/",
			MaxAge: -1,
		})
	}
	// No cookie = invitation flow — skip CSRF check (code is single-use and client-bound)

	cfg := h.workos.Config()
	ctx := c.Request().Context()

	// Exchange code for user info
	authResult, err := h.workos.UserMgr().AuthenticateWithCode(ctx, usermanagement.AuthenticateWithCodeOpts{
		ClientID: cfg.ClientID,
		Code:     code,
	})
	if err != nil {
		metrics.AuthAttemptsTotal.WithLabelValues(authTypeWorkOS, "failure").Inc()
		log.Printf("workos: callback authentication failed: %v", err)
		return c.JSON(http.StatusUnauthorized, map[string]string{
			"error": "authentication failed",
		})
	}

	// Build user display name
	name := authResult.User.FirstName
	if authResult.User.LastName != "" {
		name += " " + authResult.User.LastName
	}
	if name == "" {
		name = authResult.User.Email
	}

	// Provision org and user in local database
	// orgName is used for slug generation; workosOrgID is set if user was invited to an org
	orgName := authResult.User.Email
	localUser, err := h.workos.ProvisionOrgAndUser(ctx, authResult.User.Email, name, orgName, authResult.User.ID, authResult.OrganizationID)
	if err != nil {
		metrics.AuthAttemptsTotal.WithLabelValues(authTypeWorkOS, "failure").Inc()
		log.Printf("workos: provisioning failed: %v", err)
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to provision user",
		})
	}

	// Store the access token mapped to user for session validation
	if h.workos.Store() != nil {
		_ = h.workos.Store().StoreAccessToken(ctx, localUser.ID, authResult.AccessToken)
	}

	// Set session cookie with the access token
	cookieDomain := cfg.CookieDomain
	c.SetCookie(&http.Cookie{
		Name:     "workos_session",
		Value:    authResult.AccessToken,
		Path:     "/",
		Domain:   cookieDomain,
		MaxAge:   86400 * 7, // 7 days
		HttpOnly: true,
		Secure:   isSecureRequest(c),
		SameSite: http.SameSiteLaxMode,
	})

	metrics.AuthAttemptsTotal.WithLabelValues(authTypeWorkOS, "success").Inc()

	// Redirect to dashboard after login
	return c.Redirect(http.StatusFound, "/")
}

// HandleLogout ends the session via WorkOS's hosted logout. Clearing our own
// cookies is NOT enough — the WorkOS SSO session would survive, so the next hit
// to /auth/login silently re-authenticates the user (the "logout logs me back
// in" loop). Handing the browser WorkOS's logout URL tears down the WorkOS
// session cookie itself, then redirects to the Sign-out redirect configured in
// the WorkOS dashboard.
//
// We intentionally do NOT pass return_to: the post-logout destination is
// WorkOS-managed dashboard config (per environment), not app code. That config
// is required — without a configured Sign-out redirect WorkOS returns
// app-homepage-url-not-found.
func (h *OAuthHandlers) HandleLogout(c echo.Context) error {
	var sessionID string
	if cookie, err := c.Cookie("workos_session"); err == nil && cookie.Value != "" {
		// The WorkOS session id is the `sid` claim of the access token; it's
		// required to build the hosted logout URL.
		sessionID = sessionIDFromAccessToken(cookie.Value)

		// Invalidate the server-side session if we can identify the user.
		if store := h.workos.Store(); store != nil {
			ctx := c.Request().Context()
			if user, err := store.GetUserByAccessToken(ctx, cookie.Value); err == nil {
				_ = store.DeleteAccessTokensForUser(ctx, user.ID)
			}
		}
	}

	// Clear all auth cookies.
	ClearAllCookies(c)

	// Hand back WorkOS's hosted logout URL for the browser to follow. GetLogoutURL
	// is an offline URL builder; the real teardown + redirect happen when the
	// browser visits it.
	if mgr := h.workos.UserMgr(); mgr != nil && sessionID != "" {
		if logoutURL, err := mgr.GetLogoutURL(usermanagement.GetLogoutURLOpts{SessionID: sessionID}); err == nil {
			return c.JSON(http.StatusOK, map[string]string{
				"message":   "logged out",
				"logoutUrl": logoutURL.String(),
			})
		}
	}

	// Fallback: no WorkOS session to end — the client falls back to /auth/login.
	return c.JSON(http.StatusOK, map[string]string{"message": "logged out"})
}

// sessionIDFromAccessToken extracts the WorkOS `sid` claim from an access-token
// JWT without verifying its signature. The token was already validated for this
// request by the auth middleware; here we only need the session id to build the
// logout URL, so an unverified parse is sufficient (and avoids needing WorkOS's
// JWKS at logout time).
func sessionIDFromAccessToken(token string) string {
	claims := jwt.MapClaims{}
	if _, _, err := jwt.NewParser().ParseUnverified(token, claims); err != nil {
		return ""
	}
	if sid, ok := claims["sid"].(string); ok {
		return sid
	}
	return ""
}

// HandleMe returns the current user info from the authenticated context.
func (h *OAuthHandlers) HandleMe(c echo.Context) error {
	userID := c.Get("user_id")
	email := c.Get("user_email")
	orgID, _ := GetOrgID(c)

	resp := map[string]interface{}{
		"id":    userID,
		"email": email,
		"orgId": orgID,
	}

	// If we have a store and WorkOS org manager, include the user's org list
	store := h.workos.Store()
	orgMgr := h.workos.OrgMgr()
	if store != nil && orgMgr != nil {
		if uid, ok := userID.(uuid.UUID); ok {
			user, err := store.GetUserByEmail(c.Request().Context(), email.(string))
			if err == nil && user.WorkOSUserID != nil {
				memberships, err := orgMgr.ListUserMemberships(c.Request().Context(), *user.WorkOSUserID)
				if err == nil {
					type orgInfo struct {
						ID         uuid.UUID `json:"id"`
						Name       string    `json:"name"`
						IsPersonal bool      `json:"isPersonal"`
						IsActive   bool      `json:"isActive"`
					}
					var orgs []orgInfo
					for _, m := range memberships {
						localOrg, err := store.GetOrgByWorkOSID(c.Request().Context(), m.OrganizationID)
						if err == nil {
							orgs = append(orgs, orgInfo{
								ID:         localOrg.ID,
								Name:       localOrg.Name,
								IsPersonal: localOrg.IsPersonal,
								IsActive:   localOrg.ID == user.OrgID,
							})
						}
					}
					resp["orgs"] = orgs
				}
			}
			_ = uid // suppress unused
		}
	}

	return c.JSON(http.StatusOK, resp)
}

// isSecureRequest returns true if the request is over HTTPS,
// either directly or via a TLS-terminating proxy (e.g. Caddy, ALB).
func isSecureRequest(c echo.Context) bool {
	if c.Request().TLS != nil {
		return true
	}
	return c.Request().Header.Get("X-Forwarded-Proto") == "https"
}

func generateState() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// SetRefreshCookie sets a refresh token cookie (used for token renewal).
func SetRefreshCookie(c echo.Context, refreshToken, domain string) {
	c.SetCookie(&http.Cookie{
		Name:     "workos_refresh",
		Value:    refreshToken,
		Path:     "/",
		Domain:   domain,
		MaxAge:   86400 * 30, // 30 days
		HttpOnly: true,
		Secure:   isSecureRequest(c),
		SameSite: http.SameSiteLaxMode,
	})
}

// ClearAllCookies helper to clear all auth cookies (used for force-logout).
func ClearAllCookies(c echo.Context) {
	for _, name := range []string{"workos_session", "workos_refresh", "oauth_state"} {
		c.SetCookie(&http.Cookie{
			Name:     name,
			Value:    "",
			Path:     "/",
			MaxAge:   -1,
			Expires:  time.Unix(0, 0),
			HttpOnly: true,
		})
	}
}
