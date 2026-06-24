package webhook

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strconv"
	"strings"
	"testing"
)

// TestSignMatchesStandardWebhooks proves Sign produces exactly
// v1,base64(HMAC-SHA256(key, "{id}.{ts}.{body}")) where key is recovered from
// the whsec_ secret — i.e. byte-for-byte what the shipped TS verifyWebhook
// computes. The expected value is derived from the RAW key (not via Sign), so
// this also exercises SecretKeyBytes' decode path, not a tautology.
func TestSignMatchesStandardWebhooks(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef") // 32 bytes
	secret := SecretPrefix + base64.StdEncoding.EncodeToString(key)
	id := "whd_abc123"
	ts := int64(1700000000)
	body := []byte(`{"type":"sandbox.stopped","event":{"data":{"reason":"user_requested"}}}`)

	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(id + "." + strconv.FormatInt(ts, 10) + "."))
	mac.Write(body)
	want := "v1," + base64.StdEncoding.EncodeToString(mac.Sum(nil))

	got := Sign(secret, id, ts, body)
	if got != want {
		t.Fatalf("Sign mismatch:\n got=%s\nwant=%s", got, want)
	}
}

func TestSignDeterministicAndBodySensitive(t *testing.T) {
	secret, err := GenerateSecret()
	if err != nil {
		t.Fatal(err)
	}
	a := Sign(secret, "whd_1", 1700000000, []byte(`{"a":1}`))
	b := Sign(secret, "whd_1", 1700000000, []byte(`{"a":1}`))
	if a != b {
		t.Fatal("Sign is not deterministic")
	}
	if !strings.HasPrefix(a, "v1,") {
		t.Fatalf("missing v1 prefix: %s", a)
	}
	if Sign(secret, "whd_1", 1700000000, []byte(`{"a":2}`)) == a {
		t.Fatal("signature did not change with body")
	}
	if Sign(secret, "whd_2", 1700000000, []byte(`{"a":1}`)) == a {
		t.Fatal("signature did not change with webhook-id")
	}
}

func TestGenerateSecret(t *testing.T) {
	s, err := GenerateSecret()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(s, SecretPrefix) {
		t.Fatalf("missing whsec_ prefix: %s", s)
	}
	raw := strings.TrimPrefix(s, SecretPrefix)
	dec, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		t.Fatalf("secret body is not standard base64: %v", err)
	}
	if len(dec) != secretBytes {
		t.Fatalf("want %d random bytes, got %d", secretBytes, len(dec))
	}
	// Two generated secrets must differ.
	s2, _ := GenerateSecret()
	if s == s2 {
		t.Fatal("GenerateSecret returned identical secrets")
	}
}

func TestSecretKeyBytes(t *testing.T) {
	key := []byte("an-arbitrary-32-byte-long-keyAAA")
	secret := SecretPrefix + base64.StdEncoding.EncodeToString(key)
	if got := SecretKeyBytes(secret); string(got) != string(key) {
		t.Fatalf("base64 secret not decoded to raw key bytes")
	}
	// A non-base64 secret falls back to its raw UTF-8 bytes (whole string).
	weird := "whsec_not valid base64!!!"
	if got := SecretKeyBytes(weird); string(got) != weird {
		t.Fatalf("non-base64 secret should fall back to raw bytes, got %q", got)
	}
}

func TestHeaders(t *testing.T) {
	secret, _ := GenerateSecret()
	h := Headers(secret, "whd_xyz", "sb-1", 1700000000, []byte(`{}`))
	if h["webhook-id"] != "whd_xyz" {
		t.Fatalf("webhook-id should be the delivery id, got %q", h["webhook-id"])
	}
	if h["X-OC-Delivery-ID"] != "whd_xyz" || h["X-OC-Sandbox-ID"] != "sb-1" {
		t.Fatal("correlation headers not set")
	}
	if !strings.HasPrefix(h["webhook-signature"], "v1,") {
		t.Fatal("signature header malformed")
	}
	if h["webhook-timestamp"] != "1700000000" {
		t.Fatalf("timestamp header wrong: %s", h["webhook-timestamp"])
	}
}
