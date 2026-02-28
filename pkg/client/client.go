package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/opensandbox/opensandbox/pkg/types"
)

// Client is an HTTP client for the OpenSandbox API.
type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

// NewClient creates a new OpenSandbox API client.
func NewClient(baseURL, apiKey string) *Client {
	return &Client{
		baseURL: baseURL,
		apiKey:  apiKey,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// doRequest performs an HTTP request with API key authentication.
func (c *Client) doRequest(ctx context.Context, method, path string, body interface{}) (*http.Response, error) {
	var bodyReader io.Reader
	if body != nil {
		jsonData, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal request body: %w", err)
		}
		bodyReader = bytes.NewReader(jsonData)
	}

	reqURL := c.baseURL + path
	req, err := http.NewRequestWithContext(ctx, method, reqURL, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", c.apiKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("execute request: %w", err)
	}

	return resp, nil
}

// CreateSandbox creates a new sandbox.
func (c *Client) CreateSandbox(ctx context.Context, cfg types.SandboxConfig) (*types.Sandbox, error) {
	resp, err := c.doRequest(ctx, http.MethodPost, "/api/sandboxes", cfg)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var sandbox types.Sandbox
	if err := json.NewDecoder(resp.Body).Decode(&sandbox); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return &sandbox, nil
}

// ListSandboxes lists all sandboxes.
func (c *Client) ListSandboxes(ctx context.Context) ([]types.Sandbox, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, "/api/sandboxes", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var sandboxes []types.Sandbox
	if err := json.NewDecoder(resp.Body).Decode(&sandboxes); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return sandboxes, nil
}

// GetSandbox gets a sandbox by ID.
func (c *Client) GetSandbox(ctx context.Context, sandboxID string) (*types.Sandbox, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, fmt.Sprintf("/api/sandboxes/%s", sandboxID), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var sandbox types.Sandbox
	if err := json.NewDecoder(resp.Body).Decode(&sandbox); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return &sandbox, nil
}

// KillSandbox kills (deletes) a sandbox.
func (c *Client) KillSandbox(ctx context.Context, sandboxID string) error {
	resp, err := c.doRequest(ctx, http.MethodDelete, fmt.Sprintf("/api/sandboxes/%s", sandboxID), nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	return nil
}

// SetTimeout sets the timeout for a sandbox.
func (c *Client) SetTimeout(ctx context.Context, sandboxID string, timeoutSecs int) error {
	body := map[string]int{"timeout": timeoutSecs}
	resp, err := c.doRequest(ctx, http.MethodPost, fmt.Sprintf("/api/sandboxes/%s/timeout", sandboxID), body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(respBody))
	}

	return nil
}

// HibernateSandbox hibernates a sandbox (snapshot to S3).
func (c *Client) HibernateSandbox(ctx context.Context, sandboxID string) (map[string]interface{}, error) {
	resp, err := c.doRequest(ctx, http.MethodPost, fmt.Sprintf("/api/sandboxes/%s/hibernate", sandboxID), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var result map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return result, nil
}

// WakeSandbox wakes a hibernated sandbox.
func (c *Client) WakeSandbox(ctx context.Context, sandboxID string) (*types.Sandbox, error) {
	resp, err := c.doRequest(ctx, http.MethodPost, fmt.Sprintf("/api/sandboxes/%s/wake", sandboxID), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var sandbox types.Sandbox
	if err := json.NewDecoder(resp.Body).Decode(&sandbox); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return &sandbox, nil
}

// RunCommand executes a command in a sandbox.
func (c *Client) RunCommand(ctx context.Context, sandboxID string, cmd []string) (map[string]interface{}, error) {
	body := map[string]interface{}{"cmd": cmd[0]}
	if len(cmd) > 1 {
		body["args"] = cmd[1:]
	}
	resp, err := c.doRequest(ctx, http.MethodPost, fmt.Sprintf("/api/sandboxes/%s/commands", sandboxID), body)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(respBody))
	}

	var result map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return result, nil
}

// ReadFile reads a file from a sandbox.
func (c *Client) ReadFile(ctx context.Context, sandboxID, path string) (string, error) {
	reqURL := fmt.Sprintf("/api/sandboxes/%s/files?path=%s", sandboxID, url.QueryEscape(path))
	resp, err := c.doRequest(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	// Server returns plain text content, not JSON
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read response: %w", err)
	}

	return string(body), nil
}

// WriteFile writes a file to a sandbox.
func (c *Client) WriteFile(ctx context.Context, sandboxID, path, content string) error {
	reqURL := fmt.Sprintf("%s/api/sandboxes/%s/files?path=%s", c.baseURL, sandboxID, url.QueryEscape(path))
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, reqURL, strings.NewReader(content))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-API-Key", c.apiKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("write file: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(respBody))
	}

	return nil
}

// ListDir lists files in a directory.
func (c *Client) ListDir(ctx context.Context, sandboxID, path string) ([]types.EntryInfo, error) {
	reqURL := fmt.Sprintf("/api/sandboxes/%s/files/list?path=%s", sandboxID, url.QueryEscape(path))
	resp, err := c.doRequest(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	// Server returns []EntryInfo array directly
	var entries []types.EntryInfo
	if err := json.NewDecoder(resp.Body).Decode(&entries); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return entries, nil
}

// MakeDir creates a directory in a sandbox.
func (c *Client) MakeDir(ctx context.Context, sandboxID, path string) error {
	reqURL := fmt.Sprintf("/api/sandboxes/%s/files/mkdir?path=%s", sandboxID, url.QueryEscape(path))
	resp, err := c.doRequest(ctx, http.MethodPost, reqURL, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(respBody))
	}

	return nil
}

// RemoveFile removes a file or directory from a sandbox.
func (c *Client) RemoveFile(ctx context.Context, sandboxID, path string) error {
	reqURL := fmt.Sprintf("/api/sandboxes/%s/files?path=%s", sandboxID, url.QueryEscape(path))
	resp, err := c.doRequest(ctx, http.MethodDelete, reqURL, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	return nil
}

// ListTemplates lists all templates.
func (c *Client) ListTemplates(ctx context.Context) ([]map[string]interface{}, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, "/api/templates", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var templates []map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&templates); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return templates, nil
}

// ListWorkers lists all registered workers (server mode only).
func (c *Client) ListWorkers(ctx context.Context) ([]map[string]interface{}, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, "/api/workers", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(body))
	}

	var workers []map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&workers); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return workers, nil
}
