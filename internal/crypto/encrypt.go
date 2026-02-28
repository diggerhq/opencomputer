// Package crypto provides AES-256-GCM encryption for secrets at rest.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
)

const (
	encPrefix   = "enc:"
	plainPrefix = "plain:"
)

// keyFromEnv loads the 32-byte encryption key from OPENSANDBOX_SECRET_ENCRYPTION_KEY.
// Accepts hex (64 chars) or base64 (44 chars) encoded values.
// Returns nil if not set (dev/test mode).
func keyFromEnv() []byte {
	raw := os.Getenv("OPENSANDBOX_SECRET_ENCRYPTION_KEY")
	if raw == "" {
		return nil
	}
	// Try hex first (64 hex chars = 32 bytes)
	if len(raw) == 64 {
		b, err := hex.DecodeString(raw)
		if err == nil && len(b) == 32 {
			return b
		}
	}
	// Try base64
	b, err := base64.StdEncoding.DecodeString(raw)
	if err == nil && len(b) == 32 {
		return b
	}
	b, err = base64.RawStdEncoding.DecodeString(raw)
	if err == nil && len(b) == 32 {
		return b
	}
	log.Printf("crypto: warning: OPENSANDBOX_SECRET_ENCRYPTION_KEY is set but could not be decoded as 32-byte hex or base64 — falling back to plaintext storage")
	return nil
}

// Encrypt encrypts plaintext using AES-256-GCM with the configured key.
// Returns "enc:<base64(nonce+ciphertext)>" on success.
// If no key is configured, returns "plain:<base64(plaintext)>" with a startup warning.
func Encrypt(plaintext string) (string, error) {
	key := keyFromEnv()
	if key == nil {
		log.Printf("crypto: WARNING — no encryption key configured; storing secret as base64 plaintext (set OPENSANDBOX_SECRET_ENCRYPTION_KEY for production)")
		return plainPrefix + base64.StdEncoding.EncodeToString([]byte(plaintext)), nil
	}
	return EncryptWithKey(plaintext, key)
}

// EncryptWithKey encrypts plaintext with the given 32-byte key.
func EncryptWithKey(plaintext string, key []byte) (string, error) {
	if len(key) != 32 {
		return "", fmt.Errorf("encryption key must be 32 bytes, got %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create GCM: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}
	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return encPrefix + base64.StdEncoding.EncodeToString(ciphertext), nil
}

// Decrypt decrypts a value produced by Encrypt.
// Handles both "enc:..." (AES-GCM) and "plain:..." (dev/test) formats.
func Decrypt(stored string) (string, error) {
	if strings.HasPrefix(stored, plainPrefix) {
		b, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(stored, plainPrefix))
		if err != nil {
			return "", fmt.Errorf("decode plaintext value: %w", err)
		}
		return string(b), nil
	}
	if !strings.HasPrefix(stored, encPrefix) {
		return "", fmt.Errorf("unknown secret format (expected enc: or plain: prefix)")
	}
	key := keyFromEnv()
	if key == nil {
		return "", fmt.Errorf("OPENSANDBOX_SECRET_ENCRYPTION_KEY not configured — cannot decrypt enc: values")
	}
	return DecryptWithKey(stored, key)
}

// DecryptWithKey decrypts an "enc:..." value with the given key.
func DecryptWithKey(stored string, key []byte) (string, error) {
	if len(key) != 32 {
		return "", fmt.Errorf("encryption key must be 32 bytes, got %d", len(key))
	}
	if !strings.HasPrefix(stored, encPrefix) {
		return "", fmt.Errorf("expected enc: prefix")
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(stored, encPrefix))
	if err != nil {
		return "", fmt.Errorf("base64 decode: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create GCM: %w", err)
	}
	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}
	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt: %w", err)
	}
	return string(plaintext), nil
}
