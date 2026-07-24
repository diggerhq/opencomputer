package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/config"
	"github.com/spf13/cobra"
)

const (
	testDeviceCode = "private-device-code"
	testUserCode   = "ABCD-EFGH"
	testKey        = "osb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	oldTestKey     = "osb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func authTestCommand(t *testing.T, apiURL string) (*cobra.Command, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
	}
	t.Setenv("OPENCOMPUTER_API_URL", apiURL)
	t.Setenv("OPENCOMPUTER_API_KEY", "")
	t.Setenv("SESSIONS_API_URL", "")

	cmd := &cobra.Command{}
	cmd.SetContext(context.Background())
	var stdout, stderr bytes.Buffer
	cmd.SetOut(&stdout)
	cmd.SetErr(&stderr)

	oldSleep, oldOpen, oldJSON := authSleep, openAuthBrowser, jsonOutput
	authSleep = func(context.Context, time.Duration) error { return nil }
	openAuthBrowser = func(string) error { return nil }
	jsonOutput = false
	t.Cleanup(func() {
		authSleep = oldSleep
		openAuthBrowser = oldOpen
		jsonOutput = oldJSON
	})
	return cmd, &stdout, &stderr
}

func writeJSONResponse(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func deviceReceipt() map[string]any {
	return map[string]any{
		"device_code":               testDeviceCode,
		"user_code":                 testUserCode,
		"verification_uri":          "https://auth.example.test/device",
		"verification_uri_complete": "https://auth.example.test/device?user_code=" + testUserCode,
		"expires_in":                300,
		"interval":                  1,
	}
}

func authorizedExchange() map[string]any {
	return map[string]any{
		"status": "authorized",
		"credential": map[string]any{
			"id":         "credential-1",
			"key":        testKey,
			"key_prefix": "osb_aaaa",
			"name":       "oc CLI on test",
		},
		"user": map[string]any{
			"id":    "user-1",
			"email": "igor@example.com",
			"name":  "Igor",
		},
		"org": map[string]any{
			"id":   "org-1",
			"name": "Igor's workspace",
		},
	}
}

func whoamiResponse() map[string]any {
	return map[string]any{
		"user_id":  "user-1",
		"email":    "igor@example.com",
		"org_id":   "org-1",
		"org_name": "Igor's workspace",
	}
}

func TestLoginPollsSavesVerifiesAndNeverPrintsCredential(t *testing.T) {
	var mu sync.Mutex
	var exchanges int
	var opened string
	var delays []time.Duration
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/auth/cli/device":
			if r.Method != http.MethodPost {
				t.Errorf("start method = %s", r.Method)
			}
			if r.Header.Get("X-API-Key") != "" {
				t.Error("start unexpectedly carried an API key")
			}
			writeJSONResponse(w, 200, deviceReceipt())
		case "/auth/cli/device/exchange":
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("exchange body: %v", err)
			}
			if body["device_code"] != testDeviceCode {
				t.Errorf("device code = %q", body["device_code"])
			}
			mu.Lock()
			exchanges++
			attempt := exchanges
			mu.Unlock()
			if attempt == 1 {
				writeJSONResponse(w, 202, map[string]any{
					"status":      "authorization_pending",
					"retry_after": 2,
				})
				return
			}
			writeJSONResponse(w, 200, authorizedExchange())
		case "/api/whoami":
			if r.Header.Get("X-API-Key") != testKey {
				t.Errorf("whoami key = %q", r.Header.Get("X-API-Key"))
			}
			writeJSONResponse(w, 200, whoamiResponse())
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	cmd, stdout, stderr := authTestCommand(t, server.URL)
	authSleep = func(_ context.Context, delay time.Duration) error {
		delays = append(delays, delay)
		return nil
	}
	openAuthBrowser = func(rawURL string) error {
		opened = rawURL
		return nil
	}
	if err := runLogin(cmd, false, false); err != nil {
		t.Fatalf("runLogin: %v", err)
	}

	if exchanges != 2 {
		t.Fatalf("exchange attempts = %d, want 2", exchanges)
	}
	if fmt.Sprint(delays) != "[1s 2s]" {
		t.Fatalf("poll delays = %v, want [1s 2s]", delays)
	}
	if opened != "https://auth.example.test/device?user_code="+testUserCode {
		t.Fatalf("opened URL = %q", opened)
	}
	if !strings.Contains(stderr.String(), testUserCode) ||
		!strings.Contains(stderr.String(), "https://auth.example.test/device") {
		t.Fatalf("missing confirmation instructions:\n%s", stderr.String())
	}
	combined := stdout.String() + stderr.String()
	if strings.Contains(combined, testKey) || strings.Contains(combined, testDeviceCode) {
		t.Fatalf("secret leaked to output: %q", combined)
	}
	if !strings.Contains(stdout.String(), "Logged in as igor@example.com") ||
		!strings.Contains(stdout.String(), "Igor's workspace") {
		t.Fatalf("unexpected success output:\n%s", stdout.String())
	}

	saved := config.LoadFile()
	if saved.APIKey != testKey || saved.Login == nil || saved.Login.CredentialID != "credential-1" {
		t.Fatalf("saved config = %#v", saved)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(config.ConfigPath())
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("config mode = %o", info.Mode().Perm())
		}
	}
}

func TestLoginNoBrowserAndJSONContainNoKeyOrDeviceCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/auth/cli/device":
			writeJSONResponse(w, 200, deviceReceipt())
		case "/auth/cli/device/exchange":
			writeJSONResponse(w, 200, authorizedExchange())
		case "/api/whoami":
			writeJSONResponse(w, 200, whoamiResponse())
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	cmd, stdout, stderr := authTestCommand(t, server.URL)
	jsonOutput = true
	openAuthBrowser = func(string) error {
		t.Fatal("browser opener called under --no-browser")
		return nil
	}
	if err := runLogin(cmd, false, true); err != nil {
		t.Fatalf("runLogin: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
		t.Fatalf("JSON output: %v\n%s", err, stdout.String())
	}
	combined := stdout.String() + stderr.String()
	if strings.Contains(combined, testKey) || strings.Contains(combined, testDeviceCode) {
		t.Fatalf("secret leaked to output: %q", combined)
	}
	if got["email"] != "igor@example.com" || got["org_id"] != "org-1" {
		t.Fatalf("login JSON = %#v", got)
	}
}

func TestLoginRejectsVerificationURLContainingDeviceCodeBeforePrinting(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receipt := deviceReceipt()
		receipt["verification_uri_complete"] = "https://auth.example.test/device?device_code=" + testDeviceCode
		writeJSONResponse(w, 200, receipt)
	}))
	defer server.Close()
	cmd, stdout, stderr := authTestCommand(t, server.URL)
	err := runLogin(cmd, false, true)
	if err == nil || !strings.Contains(err.Error(), "unsafe verification URL") {
		t.Fatalf("error = %v", err)
	}
	if strings.Contains(stdout.String()+stderr.String(), testDeviceCode) {
		t.Fatalf("device code leaked to output: %q", stdout.String()+stderr.String())
	}
}

func TestLoginRefusesEnvironmentCredentialWithoutCallingAPI(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		http.Error(w, "unexpected", 500)
	}))
	defer server.Close()
	cmd, _, _ := authTestCommand(t, server.URL)
	t.Setenv("OPENCOMPUTER_API_KEY", "environment-key")
	err := runLogin(cmd, true, true)
	if err == nil || !strings.Contains(err.Error(), "OPENCOMPUTER_API_KEY") {
		t.Fatalf("error = %v", err)
	}
	if calls != 0 {
		t.Fatalf("API called %d times", calls)
	}
}

func TestLoginForceStoresAndVerifiesReplacementBeforeRevokingOld(t *testing.T) {
	var sequence []string
	var mu sync.Mutex
	record := func(s string) {
		mu.Lock()
		defer mu.Unlock()
		sequence = append(sequence, s)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/whoami":
			key := r.Header.Get("X-API-Key")
			if key == oldTestKey {
				record("old-whoami")
			} else if key == testKey {
				saved := config.LoadFile()
				if saved.APIKey != testKey {
					t.Errorf("new key not saved before verification")
				}
				record("new-whoami")
			}
			writeJSONResponse(w, 200, whoamiResponse())
		case "/auth/cli/device":
			record("start")
			writeJSONResponse(w, 200, deviceReceipt())
		case "/auth/cli/device/exchange":
			record("exchange")
			writeJSONResponse(w, 200, authorizedExchange())
		case "/auth/cli/credential":
			if r.Header.Get("X-API-Key") != oldTestKey {
				t.Errorf("revoked key = %q", r.Header.Get("X-API-Key"))
			}
			if config.LoadFile().APIKey != testKey {
				t.Errorf("replacement not saved before old-key revoke")
			}
			record("old-revoke")
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	cmd, _, _ := authTestCommand(t, server.URL)
	if err := config.Save(config.Config{
		APIURL: server.URL,
		APIKey: oldTestKey,
		Login: &config.LoginMetadata{
			CredentialID: "old-id",
			KeyPrefix:    "osb_bbbb",
			Name:         "oc CLI on old",
			APIURL:       server.URL,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := runLogin(cmd, true, true); err != nil {
		t.Fatalf("runLogin --force: %v", err)
	}
	got := strings.Join(sequence, ",")
	want := "old-whoami,start,exchange,new-whoami,old-revoke"
	if got != want {
		t.Fatalf("sequence = %q, want %q", got, want)
	}
}

func TestLoginWithValidManagedCredentialExitsWithoutNewAuthorization(t *testing.T) {
	var starts int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/whoami":
			writeJSONResponse(w, 200, whoamiResponse())
		case "/auth/cli/device":
			starts++
			http.Error(w, "unexpected", 500)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	cmd, stdout, _ := authTestCommand(t, server.URL)
	if err := config.Save(config.Config{
		APIURL: server.URL,
		APIKey: testKey,
		Login: &config.LoginMetadata{
			CredentialID: "credential-1",
			KeyPrefix:    "osb_aaaa",
			Name:         "oc CLI on test",
			APIURL:       server.URL,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := runLogin(cmd, false, false); err != nil {
		t.Fatalf("runLogin: %v", err)
	}
	if starts != 0 {
		t.Fatalf("started %d new authorizations", starts)
	}
	if !strings.Contains(stdout.String(), "Already logged in as igor@example.com") {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestLoginForceNeverRevokesManualFileKey(t *testing.T) {
	var revokes int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/auth/cli/device":
			writeJSONResponse(w, 200, deviceReceipt())
		case "/auth/cli/device/exchange":
			writeJSONResponse(w, 200, authorizedExchange())
		case "/api/whoami":
			writeJSONResponse(w, 200, whoamiResponse())
		case "/auth/cli/credential":
			revokes++
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	cmd, _, _ := authTestCommand(t, server.URL)
	if err := config.Save(config.Config{APIURL: server.URL, APIKey: oldTestKey}); err != nil {
		t.Fatal(err)
	}
	if err := runLogin(cmd, true, true); err != nil {
		t.Fatalf("runLogin --force: %v", err)
	}
	if revokes != 0 {
		t.Fatalf("manual key was remotely revoked %d time(s)", revokes)
	}
}

func TestLogoutAmbiguousFailureRetainsLocalCredential(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSONResponse(w, 503, map[string]string{"error": "credential_revocation_unavailable"})
	}))
	defer server.Close()
	cmd, _, _ := authTestCommand(t, server.URL)
	if err := config.Save(config.Config{
		APIURL: server.URL,
		APIKey: testKey,
		Login: &config.LoginMetadata{
			CredentialID: "credential-1",
			KeyPrefix:    "osb_aaaa",
			Name:         "oc CLI on test",
			APIURL:       server.URL,
		},
	}); err != nil {
		t.Fatal(err)
	}
	err := runLogout(cmd, false)
	if err == nil || !strings.Contains(err.Error(), "local login was retained") {
		t.Fatalf("error = %v", err)
	}
	if got := config.LoadFile(); got.APIKey != testKey || got.Login == nil {
		t.Fatalf("credential was cleared after ambiguous revoke: %#v", got)
	}
}

func TestLogoutRevokesAndClearsManagedCredential(t *testing.T) {
	var revoked string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		revoked = r.Header.Get("X-API-Key")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	cmd, stdout, _ := authTestCommand(t, server.URL)
	if err := config.Save(config.Config{
		APIURL: server.URL,
		APIKey: testKey,
		Login: &config.LoginMetadata{
			CredentialID: "credential-1",
			KeyPrefix:    "osb_aaaa",
			Name:         "oc CLI on test",
			APIURL:       server.URL,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := runLogout(cmd, false); err != nil {
		t.Fatalf("runLogout: %v", err)
	}
	if revoked != testKey {
		t.Fatalf("revoked key = %q", revoked)
	}
	if got := config.LoadFile(); got.APIKey != "" || got.Login != nil {
		t.Fatalf("credential remains after logout: %#v", got)
	}
	if strings.TrimSpace(stdout.String()) != "Logged out." {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestLogoutLocalDoesNotCallRemote(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		http.Error(w, "unexpected", 500)
	}))
	defer server.Close()
	cmd, _, _ := authTestCommand(t, server.URL)
	if err := config.Save(config.Config{
		APIURL: server.URL,
		APIKey: testKey,
		Login: &config.LoginMetadata{
			CredentialID: "credential-1",
			KeyPrefix:    "osb_aaaa",
			Name:         "oc CLI on test",
			APIURL:       server.URL,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := runLogout(cmd, true); err != nil {
		t.Fatalf("runLogout --local: %v", err)
	}
	if calls != 0 {
		t.Fatalf("remote called %d times", calls)
	}
	if got := config.LoadFile(); got.APIKey != "" || got.Login != nil {
		t.Fatalf("local login remains: %#v", got)
	}
}

func TestLoginCancellationDoesNotSaveCredential(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/cli/device" {
			t.Fatalf("unexpected path after cancellation: %s", r.URL.Path)
		}
		writeJSONResponse(w, 200, deviceReceipt())
	}))
	defer server.Close()
	cmd, _, _ := authTestCommand(t, server.URL)
	authSleep = func(context.Context, time.Duration) error { return context.Canceled }
	err := runLogin(cmd, false, true)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("HOME"), ".oc", "config.json")); !os.IsNotExist(err) {
		t.Fatalf("config unexpectedly created: %v", err)
	}
}

func TestLoginRetriesTransientExchangeTwiceThenLeavesConfigUntouched(t *testing.T) {
	var exchanges int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/auth/cli/device":
			writeJSONResponse(w, 200, deviceReceipt())
		case "/auth/cli/device/exchange":
			exchanges++
			writeJSONResponse(w, 503, map[string]string{"error": "auth_provider_unavailable"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	cmd, _, _ := authTestCommand(t, server.URL)
	err := runLogin(cmd, false, true)
	if err == nil || !strings.Contains(err.Error(), "auth_provider_unavailable") {
		t.Fatalf("error = %v", err)
	}
	if exchanges != 3 {
		t.Fatalf("exchange attempts = %d, want 3", exchanges)
	}
	if got := config.LoadFile(); got.APIKey != "" || got.Login != nil {
		t.Fatalf("transient failure mutated config: %#v", got)
	}
}

func TestLoginDoesNotRetryPostAuthorizationCredentialFailure(t *testing.T) {
	var exchanges int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/auth/cli/device":
			writeJSONResponse(w, 200, deviceReceipt())
		case "/auth/cli/device/exchange":
			exchanges++
			writeJSONResponse(w, 503, map[string]string{"error": "credential_creation_failed"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	cmd, _, _ := authTestCommand(t, server.URL)
	err := runLogin(cmd, false, true)
	if err == nil || !strings.Contains(err.Error(), "run `oc login` again") {
		t.Fatalf("error = %v", err)
	}
	if exchanges != 1 {
		t.Fatalf("exchange attempts = %d, want 1 for a consumed device grant", exchanges)
	}
	if got := config.LoadFile(); got.APIKey != "" || got.Login != nil {
		t.Fatalf("credential failure mutated config: %#v", got)
	}
}

func TestWhoamiJSONIsStable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != testKey {
			t.Errorf("key = %q", r.Header.Get("X-API-Key"))
		}
		writeJSONResponse(w, 200, whoamiResponse())
	}))
	defer server.Close()
	cmd, stdout, _ := authTestCommand(t, server.URL)
	t.Setenv("OPENCOMPUTER_API_KEY", testKey)
	jsonOutput = true
	if err := runWhoami(cmd); err != nil {
		t.Fatalf("runWhoami: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf(
		`{"api_url":%q,"email":"igor@example.com","org_id":"org-1","org_name":"Igor's workspace","user_id":"user-1"}`,
		server.URL,
	)
	encoded, _ := json.Marshal(got)
	var wantMap map[string]any
	_ = json.Unmarshal([]byte(want), &wantMap)
	wantEncoded, _ := json.Marshal(wantMap)
	if string(encoded) != string(wantEncoded) {
		t.Fatalf("whoami JSON = %s, want %s", encoded, wantEncoded)
	}
}

func TestAuthClientNeverFollowsRedirectsWithCredentials(t *testing.T) {
	var destinationCalls int
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		destinationCalls++
		if r.Header.Get("X-API-Key") != "" {
			t.Errorf("redirect leaked key %q", r.Header.Get("X-API-Key"))
		}
		writeJSONResponse(w, 200, whoamiResponse())
	}))
	defer destination.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL+r.URL.Path, http.StatusFound)
	}))
	defer redirector.Close()

	_, err := newCLIAuthHTTP(redirector.URL).whoami(context.Background(), testKey)
	if err == nil {
		t.Fatal("redirecting auth endpoint unexpectedly succeeded")
	}
	if destinationCalls != 0 {
		t.Fatalf("redirect destination called %d times", destinationCalls)
	}
}

func TestConfigSetAPIKeyClearsLoginManagementMetadata(t *testing.T) {
	cmd, _, _ := authTestCommand(t, "https://example.test")
	if err := config.Save(config.Config{
		APIURL: "https://example.test",
		APIKey: oldTestKey,
		Login: &config.LoginMetadata{
			CredentialID: "old-id",
			KeyPrefix:    "osb_bbbb",
			Name:         "oc CLI on old",
			APIURL:       "https://example.test",
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := configSetCmd.RunE(cmd, []string{"api-key", testKey}); err != nil {
		t.Fatalf("config set api-key: %v", err)
	}
	got := config.LoadFile()
	if got.APIKey != testKey || got.Login != nil {
		t.Fatalf("config set left login-managed state: %#v", got)
	}
}
