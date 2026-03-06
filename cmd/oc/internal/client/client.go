package client

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/gorilla/websocket"
)

type contextKey struct{}

// Client is an HTTP client for the OpenComputer API.
type Client struct {
	baseURL    string
	apiKey     string
	token      string // Bearer token for direct worker access
	httpClient *http.Client
}

// APIError represents an error response from the API.
type APIError struct {
	StatusCode int
	Message    string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("API error %d: %s", e.StatusCode, e.Message)
}

// New creates a new API client.
func New(baseURL, apiKey string) *Client {
	baseURL = strings.TrimRight(baseURL, "/")
	if !strings.HasSuffix(baseURL, "/api") {
		baseURL += "/api"
	}
	return &Client{
		baseURL:    baseURL,
		apiKey:     apiKey,
		httpClient: &http.Client{},
	}
}

// WithClient stores the client in the context.
func WithClient(ctx context.Context, c *Client) context.Context {
	return context.WithValue(ctx, contextKey{}, c)
}

// FromContext retrieves the client from the context.
func FromContext(ctx context.Context) *Client {
	return ctx.Value(contextKey{}).(*Client)
}

// NewWorker creates a client that authenticates with a Bearer token directly to a worker.
// Worker routes have no /api prefix (unlike the control plane).
func NewWorker(connectURL, token string) *Client {
	connectURL = strings.TrimRight(connectURL, "/")
	return &Client{
		baseURL:    connectURL,
		token:      token,
		httpClient: &http.Client{},
	}
}

func (c *Client) headers() http.Header {
	h := http.Header{}
	if c.token != "" {
		h.Set("Authorization", "Bearer "+c.token)
	} else if c.apiKey != "" {
		h.Set("X-API-Key", c.apiKey)
	}
	return h
}

func (c *Client) do(req *http.Request) (*http.Response, error) {
	for k, v := range c.headers() {
		req.Header[k] = v
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		var errResp struct {
			Error string `json:"error"`
		}
		msg := string(body)
		if json.Unmarshal(body, &errResp) == nil && errResp.Error != "" {
			msg = errResp.Error
		}
		return nil, &APIError{StatusCode: resp.StatusCode, Message: msg}
	}
	return resp, nil
}

// Get performs a GET request and decodes the JSON response.
func (c *Client) Get(ctx context.Context, path string, result interface{}) error {
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if result != nil {
		return json.NewDecoder(resp.Body).Decode(result)
	}
	return nil
}

// Post performs a POST request with a JSON body and decodes the response.
func (c *Client) Post(ctx context.Context, path string, body, result interface{}) error {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		bodyReader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+path, bodyReader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if result != nil {
		return json.NewDecoder(resp.Body).Decode(result)
	}
	return nil
}

// Put performs a PUT request with a raw body.
func (c *Client) Put(ctx context.Context, path string, body io.Reader) error {
	req, err := http.NewRequestWithContext(ctx, "PUT", c.baseURL+path, body)
	if err != nil {
		return err
	}
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// Delete performs a DELETE request.
func (c *Client) Delete(ctx context.Context, path string) error {
	req, err := http.NewRequestWithContext(ctx, "DELETE", c.baseURL+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// DeleteIgnoreNotFound performs a DELETE request, ignoring 404 errors.
func (c *Client) DeleteIgnoreNotFound(ctx context.Context, path string) error {
	err := c.Delete(ctx, path)
	if err != nil {
		if apiErr, ok := err.(*APIError); ok && apiErr.StatusCode == 404 {
			return nil
		}
	}
	return err
}

// DialWebSocket opens a WebSocket connection.
func (c *Client) DialWebSocket(ctx context.Context, path string) (*websocket.Conn, error) {
	wsURL := c.baseURL + path
	wsURL = strings.Replace(wsURL, "http://", "ws://", 1)
	wsURL = strings.Replace(wsURL, "https://", "wss://", 1)

	dialer := websocket.Dialer{}
	conn, _, err := dialer.DialContext(ctx, wsURL, c.headers())
	if err != nil {
		return nil, fmt.Errorf("websocket dial: %w", err)
	}
	return conn, nil
}

// PostRaw performs a POST with no body and returns no result (for simple actions).
func (c *Client) PostRaw(ctx context.Context, path string) error {
	return c.Post(ctx, path, nil, nil)
}

// BaseURL returns the client's base URL.
func (c *Client) BaseURL() string {
	return c.baseURL
}

// PostSSE performs a POST and streams SSE events, calling onEvent for each parsed event.
// Returns the exit code from the "exit" event, or -1 if none received.
func (c *Client) PostSSE(ctx context.Context, path string, body interface{}, onEvent func(eventType string, data json.RawMessage)) (int, error) {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return -1, err
		}
		bodyReader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+path, bodyReader)
	if err != nil {
		return -1, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := c.do(req)
	if err != nil {
		return -1, err
	}
	defer resp.Body.Close()

	exitCode := -1
	scanner := bufio.NewScanner(resp.Body)
	var eventType string
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			eventType = ""
			continue
		}
		if strings.HasPrefix(line, ": ") {
			// SSE comment (keepalive)
			continue
		}
		if strings.HasPrefix(line, "event: ") {
			eventType = strings.TrimSpace(line[7:])
			continue
		}
		if strings.HasPrefix(line, "data: ") {
			raw := json.RawMessage(line[6:])
			if eventType == "exit" {
				var exitData struct {
					ExitCode int `json:"exit_code"`
				}
				if json.Unmarshal(raw, &exitData) == nil {
					exitCode = exitData.ExitCode
				}
			}
			if onEvent != nil {
				onEvent(eventType, raw)
			}
		}
	}
	return exitCode, scanner.Err()
}

// CreatePTYSession creates a PTY session and returns the session ID.
func (c *Client) CreatePTYSession(ctx context.Context, sandboxID string) (string, error) {
	var result struct {
		SessionID string `json:"sessionID"`
	}
	err := c.Post(ctx, "/sandboxes/"+sandboxID+"/pty", map[string]int{"cols": 120, "rows": 40}, &result)
	if err != nil {
		return "", err
	}
	return result.SessionID, nil
}
