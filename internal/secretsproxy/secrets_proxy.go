package secretsproxy

import (
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"sync"
)

// SecretsProxy is an HTTP CONNECT proxy that intercepts HTTPS traffic from
// sandboxes and substitutes sealed opaque tokens with real secret values.
// Real values never enter the VM — the VM only sees tokens like osb_sealed_xxx.
type SecretsProxy struct {
	ca       *CA
	sessions sync.Map // sandboxIP (string) → *ProxySession
	listener net.Listener
}

// ProxySession holds the sealed→real token mapping for one sandbox.
type ProxySession struct {
	SandboxID    string
	SealedTokens map[string]string // "osb_sealed_xxx" → real value
	AllowedHosts []string          // nil = all allowed; supports "*." prefix wildcards
}

// NewSecretsProxy starts an HTTP proxy listener on addr (e.g. "0.0.0.0:3128").
func NewSecretsProxy(ca *CA, addr string) (*SecretsProxy, error) {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("listen %s: %w", addr, err)
	}
	sp := &SecretsProxy{ca: ca, listener: lis}
	go sp.serve()
	log.Printf("secrets-proxy: listening on %s", addr)
	return sp, nil
}

// CreateSession generates sealed tokens for the given env var map and stores a
// proxy session keyed by sandboxIP. Returns {envVarName: sealedToken} — these
// go into /etc/environment inside the VM.
func (sp *SecretsProxy) CreateSession(sandboxIP, sandboxID string, envVars map[string]string, allowedHosts []string) map[string]string {
	sealed := make(map[string]string, len(envVars))   // envVar → token
	tokenMap := make(map[string]string, len(envVars)) // token  → real value

	for envVar, realValue := range envVars {
		token := "osb_sealed_" + newToken()
		sealed[envVar] = token
		tokenMap[token] = realValue
	}

	session := &ProxySession{
		SandboxID:    sandboxID,
		SealedTokens: tokenMap,
		AllowedHosts: allowedHosts,
	}
	sp.sessions.Store(sandboxIP, session)
	log.Printf("secrets-proxy: created session for sandbox %s (ip=%s, vars=%d)", sandboxID, sandboxIP, len(envVars))
	return sealed
}

// DeleteSession removes the proxy session for the given sandbox IP.
func (sp *SecretsProxy) DeleteSession(sandboxIP string) {
	sp.sessions.Delete(sandboxIP)
}

// ProxyEnvs creates a proxy session and returns the complete set of env vars to
// inject into the VM — sealed tokens plus proxy configuration vars.
// gatewayIP is the host-side TAP IP (gateway for the VM's subnet).
// Returns nil if envVars is empty.
func (sp *SecretsProxy) ProxyEnvs(sandboxID, sandboxIP, gatewayIP string, envVars map[string]string, allowedHosts []string) map[string]string {
	if len(envVars) == 0 {
		return nil
	}
	sealed := sp.CreateSession(sandboxIP, sandboxID, envVars, allowedHosts)

	proxyURL := fmt.Sprintf("http://%s:3128", gatewayIP)
	caCertPath := "/usr/local/share/ca-certificates/osb-proxy.crt"

	result := make(map[string]string, len(sealed)+7)
	for k, v := range sealed {
		result[k] = v
	}
	result["HTTP_PROXY"] = proxyURL
	result["HTTPS_PROXY"] = proxyURL
	result["http_proxy"] = proxyURL
	result["https_proxy"] = proxyURL
	result["NODE_EXTRA_CA_CERTS"] = caCertPath
	result["REQUESTS_CA_BUNDLE"] = caCertPath
	result["SSL_CERT_FILE"] = caCertPath
	return result
}

// serve accepts connections and handles each in a goroutine.
func (sp *SecretsProxy) serve() {
	for {
		conn, err := sp.listener.Accept()
		if err != nil {
			return
		}
		go sp.handleConn(conn)
	}
}

// Close shuts down the proxy listener.
func (sp *SecretsProxy) Close() error {
	return sp.listener.Close()
}

func (sp *SecretsProxy) handleConn(conn net.Conn) {
	defer conn.Close()

	clientIP, _, _ := net.SplitHostPort(conn.RemoteAddr().String())

	var session *ProxySession
	if v, ok := sp.sessions.Load(clientIP); ok {
		session = v.(*ProxySession)
	}

	// Read the HTTP CONNECT request line
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	if err != nil {
		return
	}
	req := string(buf[:n])

	var method, target string
	fmt.Sscanf(req, "%s %s", &method, &target)
	if method != "CONNECT" {
		conn.Write([]byte("HTTP/1.1 405 Method Not Allowed\r\n\r\n"))
		return
	}

	host, _, _ := net.SplitHostPort(target)
	if host == "" {
		host = target
	}

	// Egress allowlist check
	if session != nil && len(session.AllowedHosts) > 0 {
		if !hostAllowed(host, session.AllowedHosts) {
			conn.Write([]byte("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"))
			log.Printf("secrets-proxy: sandbox %s blocked egress to %s (not in allowlist)", session.SandboxID, host)
			return
		}
	}

	// Acknowledge the CONNECT tunnel
	conn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))

	// Sign an ephemeral cert for this host
	leafCert, err := sp.ca.SignForHost(host)
	if err != nil {
		log.Printf("secrets-proxy: sign cert for %s: %v", host, err)
		return
	}

	// TLS handshake with the VM (we act as the server, presenting our signed cert)
	tlsConn := tls.Server(conn, &tls.Config{
		Certificates: []tls.Certificate{*leafCert},
	})
	if err := tlsConn.Handshake(); err != nil {
		return // VM doesn't trust our CA or TLS error
	}
	defer tlsConn.Close()

	// Connect to the real upstream
	upstream, err := tls.Dial("tcp", target, &tls.Config{ServerName: host})
	if err != nil {
		log.Printf("secrets-proxy: dial %s: %v", target, err)
		return
	}
	defer upstream.Close()

	if session == nil || len(session.SealedTokens) == 0 {
		// No tokens — plain bidirectional pipe
		go io.Copy(upstream, tlsConn)
		io.Copy(tlsConn, upstream)
		return
	}

	// Upstream → VM: pass through unmodified
	go io.Copy(tlsConn, upstream)

	// VM → upstream: substitute sealed tokens with real values
	replacer := buildReplacer(session.SealedTokens)
	chunk := make([]byte, 65536)
	for {
		n, err := tlsConn.Read(chunk)
		if n > 0 {
			out := []byte(replacer.Replace(string(chunk[:n])))
			if _, werr := upstream.Write(out); werr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

// buildReplacer creates a strings.Replacer from the sealed→real map.
func buildReplacer(tokens map[string]string) *strings.Replacer {
	pairs := make([]string, 0, len(tokens)*2)
	for sealed, real := range tokens {
		pairs = append(pairs, sealed, real)
	}
	return strings.NewReplacer(pairs...)
}

// hostAllowed returns true if host matches any pattern in allowed.
// Supports exact matches and "*." prefix wildcards (e.g. "*.anthropic.com").
func hostAllowed(host string, allowed []string) bool {
	for _, pattern := range allowed {
		if pattern == "*" || pattern == host {
			return true
		}
		if strings.HasPrefix(pattern, "*.") {
			if strings.HasSuffix(host, pattern[1:]) {
				return true
			}
		}
	}
	return false
}

// newToken generates a 16-byte random hex string for sealed token IDs.
func newToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}
