package crypto

import (
	"encoding/hex"
	"strings"
	"testing"
)

func makeKey(offset byte) string {
	b := make([]byte, 32)
	for i := range b {
		b[i] = byte(i) + offset
	}
	return hex.EncodeToString(b)
}

var key1 = makeKey(0)
var key2 = makeKey(100)

func TestNewKeyRing_SingleKey(t *testing.T) {
	kr, err := NewKeyRing("v1:" + key1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if kr.ActiveVersion() != "v1" {
		t.Errorf("active version = %q, want v1", kr.ActiveVersion())
	}
	if len(kr.keys) != 1 {
		t.Errorf("key count = %d, want 1", len(kr.keys))
	}
}

func TestNewKeyRing_MultipleKeys(t *testing.T) {
	kr, err := NewKeyRing("v1:" + key1 + ",v2:" + key2)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if kr.ActiveVersion() != "v2" {
		t.Errorf("active version = %q, want v2 (last key)", kr.ActiveVersion())
	}
	if len(kr.keys) != 2 {
		t.Errorf("key count = %d, want 2", len(kr.keys))
	}
}

func TestNewKeyRing_Errors(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{"empty", ""},
		{"no colon", "v1abcdef"},
		{"short key", "v1:aabbccdd"},
		{"invalid hex", "v1:" + strings.Repeat("zz", 32)},
		{"duplicate version", "v1:" + key1 + ",v1:" + key1},
		{"empty version", ":" + key1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := NewKeyRing(tt.raw)
			if err == nil {
				t.Error("expected error, got nil")
			}
		})
	}
}

func TestEncryptDecrypt_RoundTrip(t *testing.T) {
	kr, err := NewKeyRing("v1:" + key1)
	if err != nil {
		t.Fatal(err)
	}

	original := "my-secret-api-key-12345"
	encrypted, err := kr.Encrypt(original)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	if !strings.HasPrefix(encrypted, "enc:v1:") {
		t.Errorf("encrypted = %q, want prefix enc:v1:", encrypted)
	}

	parts := strings.SplitN(encrypted, ":", 4)
	if len(parts) != 4 {
		t.Fatalf("expected 4 colon-separated parts, got %d: %q", len(parts), encrypted)
	}

	result, err := kr.Decrypt(encrypted)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if result.Plaintext != original {
		t.Errorf("plaintext = %q, want %q", result.Plaintext, original)
	}
	if result.NeedsRekey {
		t.Error("NeedsRekey should be false for active key")
	}
	if result.Version != "v1" {
		t.Errorf("version = %q, want v1", result.Version)
	}
}

func TestEncryptDecrypt_DifferentCiphertexts(t *testing.T) {
	kr, _ := NewKeyRing("v1:" + key1)

	e1, _ := kr.Encrypt("same")
	e2, _ := kr.Encrypt("same")
	if e1 == e2 {
		t.Error("encrypting same plaintext should produce different ciphertexts (random nonce)")
	}
}

func TestKeyRotation_NeedsRekey(t *testing.T) {
	kr1, _ := NewKeyRing("v1:" + key1)
	encrypted, _ := kr1.Encrypt("my-secret")

	// Add v2 as active
	kr2, _ := NewKeyRing("v1:" + key1 + ",v2:" + key2)

	result, err := kr2.Decrypt(encrypted)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if result.Plaintext != "my-secret" {
		t.Errorf("plaintext = %q, want my-secret", result.Plaintext)
	}
	if !result.NeedsRekey {
		t.Error("NeedsRekey should be true (encrypted with v1, active is v2)")
	}

	// Re-encrypt with v2
	reencrypted, _ := kr2.Encrypt(result.Plaintext)
	if !strings.HasPrefix(reencrypted, "enc:v2:") {
		t.Errorf("re-encrypted = %q, want prefix enc:v2:", reencrypted)
	}

	result2, _ := kr2.Decrypt(reencrypted)
	if result2.NeedsRekey {
		t.Error("NeedsRekey should be false after re-encryption with active key")
	}
}

func TestDecryptRejectsUnknownFormat(t *testing.T) {
	kr, _ := NewKeyRing("v1:" + key1)

	_, err := kr.Decrypt("raw:something")
	if err == nil {
		t.Error("expected error for unknown format")
	}
}

func TestDecryptRejectsUnknownVersion(t *testing.T) {
	kr, _ := NewKeyRing("v1:" + key1)

	kr2, _ := NewKeyRing("v99:" + key2)
	encrypted, _ := kr2.Encrypt("test")

	_, err := kr.Decrypt(encrypted)
	if err == nil {
		t.Error("expected error for unknown version v99")
	}
}

func TestDecryptWrongKey(t *testing.T) {
	kr1, _ := NewKeyRing("v1:" + key1)
	kr2, _ := NewKeyRing("v1:" + key2)

	encrypted, _ := kr1.Encrypt("secret")
	_, err := kr2.Decrypt(encrypted)
	if err == nil {
		t.Error("expected decrypt error with wrong key")
	}
}

func TestEmptyPlaintext(t *testing.T) {
	kr, _ := NewKeyRing("v1:" + key1)

	encrypted, err := kr.Encrypt("")
	if err != nil {
		t.Fatal(err)
	}
	result, err := kr.Decrypt(encrypted)
	if err != nil {
		t.Fatal(err)
	}
	if result.Plaintext != "" {
		t.Errorf("plaintext = %q, want empty", result.Plaintext)
	}
}

func TestLongPlaintext(t *testing.T) {
	kr, _ := NewKeyRing("v1:" + key1)

	long := strings.Repeat("a", 100000)
	encrypted, _ := kr.Encrypt(long)
	result, _ := kr.Decrypt(encrypted)
	if result.Plaintext != long {
		t.Error("round-trip failed for long plaintext")
	}
}
