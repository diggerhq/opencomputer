package auth

import "testing"

func TestMintVMDOConnectToken(t *testing.T) {
	// Golden vector: lower-hex(HMAC_SHA256("test-secret", "vmdo:sb-123")).
	// Independently reproduced with:
	//   printf 'vmdo:sb-123' | openssl dgst -sha256 -hmac 'test-secret' -r
	// The edge verifier (api-edge hmacHex(SESSION_JWT_SECRET, "vmdo:"+id)) MUST
	// produce this same string — if you change the construction, change both.
	const want = "0620f45637a37ca53c93dcf2e33f63e3f6c56124f0c929a6ae25e7b9ef25e477"
	if got := MintVMDOConnectToken("test-secret", "sb-123"); got != want {
		t.Errorf("token = %q, want %q", got, want)
	}
}

func TestMintVMDOConnectTokenEmpty(t *testing.T) {
	if MintVMDOConnectToken("", "sb-123") != "" {
		t.Error("no secret should yield empty token")
	}
	if MintVMDOConnectToken("secret", "") != "" {
		t.Error("no sandbox id should yield empty token")
	}
}

func TestMintVMDOConnectTokenPerSandbox(t *testing.T) {
	// Different sandbox ids must yield different tokens (per-box scoping is the
	// whole point — a leaked token can't be replayed against another box).
	a := MintVMDOConnectToken("secret", "sb-a")
	b := MintVMDOConnectToken("secret", "sb-b")
	if a == b || a == "" {
		t.Errorf("tokens should differ per sandbox: %q vs %q", a, b)
	}
}
