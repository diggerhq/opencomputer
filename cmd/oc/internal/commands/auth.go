package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/config"
	"github.com/spf13/cobra"
)

const maxAuthResponseBytes = 64 << 10

type deviceAuthorization struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

type loginCredential struct {
	ID        string `json:"id"`
	Key       string `json:"key"`
	KeyPrefix string `json:"key_prefix"`
	Name      string `json:"name"`
}

type loginIdentity struct {
	UserID  string `json:"user_id"`
	Email   string `json:"email"`
	OrgID   string `json:"org_id"`
	OrgName string `json:"org_name"`
	APIURL  string `json:"api_url"`
}

type deviceExchange struct {
	Status     string          `json:"status"`
	RetryAfter int             `json:"retry_after"`
	Credential loginCredential `json:"credential"`
	User       struct {
		ID    string `json:"id"`
		Email string `json:"email"`
		Name  string `json:"name"`
	} `json:"user"`
	Org struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"org"`
}

type loginResult struct {
	loginIdentity
	Credential struct {
		ID        string `json:"id"`
		KeyPrefix string `json:"key_prefix"`
		Name      string `json:"name"`
	} `json:"credential"`
}

type edgeErrorBody struct {
	Error string `json:"error"`
}

type cliAuthAPIError struct {
	Code string
	API  *client.APIError
}

func (e *cliAuthAPIError) Error() string {
	return e.API.Error()
}

func (e *cliAuthAPIError) Unwrap() error {
	return e.API
}

type cliAuthHTTP struct {
	baseURL string
	client  *http.Client
}

func newCLIAuthHTTP(apiURL string) *cliAuthHTTP {
	base := strings.TrimRight(apiURL, "/")
	base = strings.TrimSuffix(base, "/api")
	return &cliAuthHTTP{
		baseURL: base,
		client: &http.Client{
			Timeout: 30 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

func (c *cliAuthHTTP) do(
	ctx context.Context,
	method string,
	path string,
	apiKey string,
	body any,
	out any,
) (int, string, error) {
	var bodyReader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return 0, "", err
		}
		bodyReader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bodyReader)
	if err != nil {
		return 0, "", err
	}
	if body != nil || (method == http.MethodPost && path == "/auth/cli/device") {
		req.Header.Set("Content-Type", "application/json")
	}
	if apiKey != "" {
		req.Header.Set("X-API-Key", apiKey)
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxAuthResponseBytes+1))
	if err != nil {
		return resp.StatusCode, "", err
	}
	if len(raw) > maxAuthResponseBytes {
		return resp.StatusCode, "", errors.New("OpenComputer returned an oversized authentication response")
	}
	if resp.StatusCode >= 400 {
		var edgeErr edgeErrorBody
		if json.Unmarshal(raw, &edgeErr) != nil || edgeErr.Error == "" {
			edgeErr.Error = "unexpected_auth_response"
		}
		return resp.StatusCode, edgeErr.Error, nil
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return resp.StatusCode, "", errors.New("OpenComputer returned an invalid authentication response")
		}
	}
	return resp.StatusCode, "", nil
}

func (c *cliAuthHTTP) start(ctx context.Context) (deviceAuthorization, error) {
	var receipt deviceAuthorization
	status, code, err := c.do(ctx, http.MethodPost, "/auth/cli/device", "", nil, &receipt)
	if err != nil {
		return receipt, err
	}
	if status != http.StatusOK {
		return receipt, authAPIError(status, code)
	}
	verification, err := url.Parse(receipt.VerificationURIComplete)
	if err != nil || verification.Scheme != "https" || verification.Host == "" {
		return receipt, errors.New("OpenComputer returned an invalid verification URL")
	}
	if receipt.DeviceCode == "" || receipt.UserCode == "" || receipt.ExpiresIn <= 0 || receipt.Interval <= 0 {
		return receipt, errors.New("OpenComputer returned an incomplete authentication response")
	}
	if strings.Contains(receipt.VerificationURI, receipt.DeviceCode) ||
		strings.Contains(receipt.VerificationURIComplete, receipt.DeviceCode) {
		return receipt, errors.New("OpenComputer returned an unsafe verification URL")
	}
	return receipt, nil
}

func (c *cliAuthHTTP) exchange(
	ctx context.Context,
	deviceCode string,
	credentialName string,
) (deviceExchange, error) {
	var exchange deviceExchange
	status, code, err := c.do(ctx, http.MethodPost, "/auth/cli/device/exchange", "", map[string]string{
		"device_code":     deviceCode,
		"credential_name": credentialName,
	}, &exchange)
	if err != nil {
		return exchange, err
	}
	if status == http.StatusAccepted {
		if exchange.Status != "authorization_pending" {
			return exchange, errors.New("OpenComputer returned an invalid pending response")
		}
		return exchange, nil
	}
	if status != http.StatusOK {
		return exchange, authAPIError(status, code)
	}
	if exchange.Status != "authorized" ||
		exchange.Credential.ID == "" ||
		!validOrgKey(exchange.Credential.Key) ||
		exchange.User.ID == "" ||
		exchange.Org.ID == "" {
		return exchange, errors.New("OpenComputer returned an incomplete login credential")
	}
	return exchange, nil
}

func validOrgKey(key string) bool {
	if len(key) != 68 || !strings.HasPrefix(key, "osb_") {
		return false
	}
	for _, r := range key[4:] {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

func (c *cliAuthHTTP) whoami(ctx context.Context, apiKey string) (loginIdentity, error) {
	var identity loginIdentity
	status, code, err := c.do(ctx, http.MethodGet, "/api/whoami", apiKey, nil, &identity)
	if err != nil {
		return identity, err
	}
	if status != http.StatusOK {
		return identity, authAPIError(status, code)
	}
	identity.APIURL = c.baseURL
	if identity.OrgID == "" {
		return identity, errors.New("OpenComputer returned an incomplete identity response")
	}
	return identity, nil
}

func (c *cliAuthHTTP) revoke(ctx context.Context, apiKey string) error {
	status, code, err := c.do(ctx, http.MethodDelete, "/auth/cli/credential", apiKey, nil, nil)
	if err != nil {
		return err
	}
	switch status {
	case http.StatusNoContent, http.StatusUnauthorized, http.StatusNotFound:
		return nil
	default:
		return authAPIError(status, code)
	}
}

func authAPIError(status int, code string) error {
	action := "Retry in a moment; existing configured credentials were not changed."
	switch code {
	case "authorization_expired":
		action = "The confirmation expired; run `oc login` again."
	case "authorization_denied":
		action = "Authorization was denied; run `oc login` again and approve the displayed code."
	case "cli_login_unavailable":
		action = "CLI login is not configured on this OpenComputer API."
	case "invalid_request":
		action = "The CLI and API disagree on the login request; update `oc` and retry."
	case "account_provisioning_unavailable":
		action = "Authorization completed, but the OpenComputer account could not be prepared; run `oc login` again."
	case "credential_creation_failed":
		action = "Authorization completed, but the CLI credential could not be created; run `oc login` again."
	}
	if code == "" {
		code = "authentication_failed"
	}
	return &cliAuthAPIError{
		Code: code,
		API: &client.APIError{
			StatusCode: status,
			Message:    fmt.Sprintf("%s: %s", code, action),
		},
	}
}

var (
	openAuthBrowser = openBrowser
	authSleep       = sleepContext
)

func openBrowser(rawURL string) error {
	var command string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		command, args = "open", []string{rawURL}
	case "windows":
		command, args = "rundll32", []string{"url.dll,FileProtocolHandler", rawURL}
	default:
		command, args = "xdg-open", []string{rawURL}
	}
	return exec.Command(command, args...).Start()
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func credentialName() string {
	hostname, err := os.Hostname()
	if err != nil {
		return "oc CLI"
	}
	hostname = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, hostname))
	if hostname == "" {
		return "oc CLI"
	}
	name := []rune("oc CLI on " + hostname)
	if len(name) > 100 {
		name = name[:100]
	}
	return string(name)
}

func printLoginResult(cmd *cobra.Command, result loginResult, already bool) error {
	if jsonOutput {
		return json.NewEncoder(cmd.OutOrStdout()).Encode(result)
	}
	prefix := "✓ Logged in as "
	if already {
		prefix = "Already logged in as "
	}
	fmt.Fprintf(cmd.OutOrStdout(), "%s%s\n", prefix, oneLine(result.Email))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-11s %s\n", "Workspace", oneLine(result.OrgName))
	fmt.Fprintf(cmd.OutOrStdout(), "  %-11s %s\n", "API", oneLine(result.APIURL))
	if !already {
		fmt.Fprintln(cmd.OutOrStdout(), "\nNext: oc agent init")
	}
	return nil
}

func identityAsLoginResult(identity loginIdentity, metadata *config.LoginMetadata) loginResult {
	result := loginResult{loginIdentity: identity}
	if metadata != nil {
		result.Credential.ID = metadata.CredentialID
		result.Credential.KeyPrefix = metadata.KeyPrefix
		result.Credential.Name = metadata.Name
	}
	return result
}

func runLogin(cmd *cobra.Command, force, noBrowser bool) error {
	source := config.EffectiveCredentialSource(cmd)
	if source == config.CredentialSourceEnvironment || source == config.CredentialSourceFlag {
		return fmt.Errorf("%s currently controls authentication; unset it before running `oc login`", source)
	}

	fileCfg := config.LoadFile()
	resolved := config.Load(cmd)
	if resolved.APIURL == "" {
		resolved.APIURL = config.DefaultAPIURL
	}
	authClient := newCLIAuthHTTP(resolved.APIURL)

	var oldManagedKey string
	var oldManagedAPI string
	if fileCfg.APIKey != "" {
		if fileCfg.Login == nil {
			if !force {
				return errors.New("a manually configured API key is already saved; use `oc login --force` to replace it locally")
			}
		} else {
			oldAPI := fileCfg.Login.APIURL
			if oldAPI == "" {
				oldAPI = resolved.APIURL
			}
			identity, err := newCLIAuthHTTP(oldAPI).whoami(cmd.Context(), fileCfg.APIKey)
			if err == nil {
				if !force {
					return printLoginResult(cmd, identityAsLoginResult(identity, fileCfg.Login), true)
				}
				oldManagedKey = fileCfg.APIKey
				oldManagedAPI = oldAPI
			} else {
				var apiErr *client.APIError
				if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusUnauthorized {
					return fmt.Errorf("checking existing login before replacement: %w", err)
				}
			}
		}
	}

	receipt, err := authClient.start(cmd.Context())
	if err != nil {
		return fmt.Errorf("starting login: %w", err)
	}
	errOut := cmd.ErrOrStderr()
	style := deployStyleFor(errOut)
	fmt.Fprintln(errOut, "Open this page to sign in:")
	fmt.Fprintf(errOut, "  %s\n\n", terminalLink(receipt.VerificationURIComplete, style))
	fmt.Fprintf(errOut, "Confirm code: %s\n", oneLine(receipt.UserCode))
	fmt.Fprintln(errOut, "Waiting for confirmation…")
	if !noBrowser {
		if err := openAuthBrowser(receipt.VerificationURIComplete); err != nil {
			fmt.Fprintf(errOut, "Could not open a browser automatically: %s\n", oneLine(err.Error()))
		}
	}

	interval := time.Duration(receipt.Interval) * time.Second
	deadline := time.Now().Add(time.Duration(receipt.ExpiresIn) * time.Second)
	var exchange deviceExchange
	consecutiveTransientFailures := 0
	for {
		if time.Now().Add(interval).After(deadline) {
			return authAPIError(http.StatusGone, "authorization_expired")
		}
		if err := authSleep(cmd.Context(), interval); err != nil {
			return err
		}
		exchange, err = authClient.exchange(cmd.Context(), receipt.DeviceCode, credentialName())
		if err != nil {
			var authErr *cliAuthAPIError
			if errors.As(err, &authErr) &&
				authErr.Code == "auth_provider_unavailable" &&
				consecutiveTransientFailures < 2 {
				consecutiveTransientFailures++
				continue
			}
			return fmt.Errorf("confirming login: %w", err)
		}
		consecutiveTransientFailures = 0
		if exchange.Status == "authorized" {
			break
		}
		if exchange.RetryAfter > 0 {
			next := time.Duration(exchange.RetryAfter) * time.Second
			if next > interval {
				interval = next
			}
		}
	}

	nextCfg := fileCfg
	nextCfg.APIURL = resolved.APIURL
	nextCfg.APIKey = exchange.Credential.Key
	nextCfg.Login = &config.LoginMetadata{
		CredentialID: exchange.Credential.ID,
		KeyPrefix:    exchange.Credential.KeyPrefix,
		Name:         exchange.Credential.Name,
		APIURL:       resolved.APIURL,
	}
	if err := config.Save(nextCfg); err != nil {
		return fmt.Errorf(
			"login was authorized but the credential could not be saved; remove %q in the dashboard if needed: %w",
			exchange.Credential.Name,
			err,
		)
	}

	identity, err := authClient.whoami(cmd.Context(), exchange.Credential.Key)
	if err != nil {
		return fmt.Errorf(
			"login credential was saved but verification failed; inspect it in the dashboard before retrying: %w",
			err,
		)
	}

	if oldManagedKey != "" {
		if err := newCLIAuthHTTP(oldManagedAPI).revoke(cmd.Context(), oldManagedKey); err != nil {
			return fmt.Errorf(
				"replacement login is active, but the previous CLI credential could not be revoked; remove it in the dashboard: %w",
				err,
			)
		}
	}

	result := identityAsLoginResult(identity, nextCfg.Login)
	return printLoginResult(cmd, result, false)
}

func runWhoami(cmd *cobra.Command) error {
	cfg := config.Load(cmd)
	if cfg.APIKey == "" {
		return errors.New("not logged in; run `oc login` or set OPENCOMPUTER_API_KEY")
	}
	identity, err := newCLIAuthHTTP(cfg.APIURL).whoami(cmd.Context(), cfg.APIKey)
	if err != nil {
		return err
	}
	if jsonOutput {
		return json.NewEncoder(cmd.OutOrStdout()).Encode(identity)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "User        %s\n", oneLine(identity.Email))
	fmt.Fprintf(cmd.OutOrStdout(), "Workspace   %s\n", oneLine(identity.OrgName))
	fmt.Fprintf(cmd.OutOrStdout(), "Org ID      %s\n", oneLine(identity.OrgID))
	fmt.Fprintf(cmd.OutOrStdout(), "API         %s\n", oneLine(identity.APIURL))
	return nil
}

func runLogout(cmd *cobra.Command, localOnly bool) error {
	source := config.EffectiveCredentialSource(cmd)
	if source == config.CredentialSourceEnvironment || source == config.CredentialSourceFlag {
		return fmt.Errorf("%s still controls authentication; unset it before logging out", source)
	}
	fileCfg := config.LoadFile()
	if fileCfg.APIKey == "" || fileCfg.Login == nil {
		return errors.New("there is no CLI-managed login to revoke")
	}

	if !localOnly {
		apiURL := fileCfg.Login.APIURL
		if apiURL == "" {
			apiURL = fileCfg.APIURL
		}
		if apiURL == "" {
			apiURL = config.DefaultAPIURL
		}
		if err := newCLIAuthHTTP(apiURL).revoke(cmd.Context(), fileCfg.APIKey); err != nil {
			return fmt.Errorf("remote logout was not confirmed; local login was retained (retry or use `oc logout --local`): %w", err)
		}
	}

	fileCfg.APIKey = ""
	fileCfg.Login = nil
	if err := config.Save(fileCfg); err != nil {
		return fmt.Errorf("clearing local login: %w", err)
	}
	if jsonOutput {
		return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]string{"status": "logged_out"})
	}
	fmt.Fprintln(cmd.OutOrStdout(), "Logged out.")
	return nil
}

var loginCmd = &cobra.Command{
	Use:   "login",
	Short: "Sign in to OpenComputer",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		force, _ := cmd.Flags().GetBool("force")
		noBrowser, _ := cmd.Flags().GetBool("no-browser")
		return runLogin(cmd, force, noBrowser)
	},
}

var whoamiCmd = &cobra.Command{
	Use:   "whoami",
	Short: "Show the current OpenComputer identity",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		return runWhoami(cmd)
	},
}

var logoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "Revoke the CLI login and clear it locally",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		localOnly, _ := cmd.Flags().GetBool("local")
		return runLogout(cmd, localOnly)
	},
}

func init() {
	loginCmd.Flags().Bool("no-browser", false, "Print the confirmation URL without opening a browser")
	loginCmd.Flags().Bool("force", false, "Replace an existing saved credential")
	logoutCmd.Flags().Bool("local", false, "Clear local login state without remote revocation")
}
