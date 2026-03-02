// Package crypto provides AES-256-GCM encryption with versioned key rotation.
//
// Encrypted format: enc:<version>:<nonce-base64>:<ciphertext-base64>
//
// Key ring format (env var OPENSANDBOX_ENCRYPTION_KEYS):
//
//	v1:aabbccdd...(64 hex chars),v2:eeff0011...(64 hex chars)
//
// The last key in the list is the "active" key used for new encryptions.
// All keys are available for decryption, enabling seamless key rotation.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"strings"
)

// KeyRing holds multiple versioned AES-256-GCM keys for encryption and decryption.
// The active version is used for all new encryptions; all versions decrypt.
type KeyRing struct {
	keys          map[string]cipher.AEAD
	activeVersion string
}

// DecryptResult holds the decrypted plaintext and whether re-encryption is needed.
type DecryptResult struct {
	Plaintext  string
	NeedsRekey bool   // true if decrypted with a non-active key version
	Version    string // key version that was used for decryption
}

// NewKeyRing parses a versioned key string and builds a KeyRing.
// Format: "v1:<64hex>,v2:<64hex>,..." — last key becomes the active version.
func NewKeyRing(raw string) (*KeyRing, error) {
	if raw == "" {
		return nil, fmt.Errorf("encryption keys cannot be empty")
	}

	kr := &KeyRing{keys: make(map[string]cipher.AEAD)}

	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}

		idx := strings.Index(part, ":")
		if idx < 0 {
			return nil, fmt.Errorf("invalid key format (expected version:hex): %q", part)
		}

		version := part[:idx]
		hexKey := part[idx+1:]

		if version == "" {
			return nil, fmt.Errorf("empty version in key segment: %q", part)
		}
		if _, exists := kr.keys[version]; exists {
			return nil, fmt.Errorf("duplicate key version: %q", version)
		}

		keyBytes, err := hex.DecodeString(hexKey)
		if err != nil {
			return nil, fmt.Errorf("invalid hex for version %q: %w", version, err)
		}
		if len(keyBytes) != 32 {
			return nil, fmt.Errorf("key version %q must be 32 bytes (64 hex chars), got %d bytes", version, len(keyBytes))
		}

		block, err := aes.NewCipher(keyBytes)
		if err != nil {
			return nil, fmt.Errorf("create cipher for version %q: %w", version, err)
		}
		gcm, err := cipher.NewGCM(block)
		if err != nil {
			return nil, fmt.Errorf("create GCM for version %q: %w", version, err)
		}

		kr.keys[version] = gcm
		kr.activeVersion = version
	}

	if len(kr.keys) == 0 {
		return nil, fmt.Errorf("no valid keys found")
	}
	return kr, nil
}

// ActiveVersion returns the version string of the active encryption key.
func (kr *KeyRing) ActiveVersion() string {
	return kr.activeVersion
}

// Encrypt encrypts plaintext using the active key version.
// Returns format: enc:<version>:<nonce-base64>:<ciphertext-base64>
func (kr *KeyRing) Encrypt(plaintext string) (string, error) {
	gcm := kr.keys[kr.activeVersion]

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}

	ciphertext := gcm.Seal(nil, nonce, []byte(plaintext), nil)

	return fmt.Sprintf("enc:%s:%s:%s",
		kr.activeVersion,
		base64.StdEncoding.EncodeToString(nonce),
		base64.StdEncoding.EncodeToString(ciphertext),
	), nil
}

// Decrypt decrypts a stored value in format enc:<version>:<nonce>:<ciphertext>.
// Returns DecryptResult with NeedsRekey=true if encrypted with a non-active key.
func (kr *KeyRing) Decrypt(stored string) (*DecryptResult, error) {
	if !strings.HasPrefix(stored, "enc:") {
		return nil, fmt.Errorf("unknown secret format (expected enc: prefix, got %q)", stored[:min(len(stored), 10)])
	}

	parts := strings.SplitN(stored[4:], ":", 3)
	if len(parts) != 3 {
		return nil, fmt.Errorf("invalid encrypted format: expected enc:<version>:<nonce>:<ciphertext>")
	}

	version, nonceB64, ctB64 := parts[0], parts[1], parts[2]

	gcm, ok := kr.keys[version]
	if !ok {
		return nil, fmt.Errorf("unknown key version %q — not in key ring", version)
	}

	nonce, err := base64.StdEncoding.DecodeString(nonceB64)
	if err != nil {
		return nil, fmt.Errorf("decode nonce: %w", err)
	}

	ciphertext, err := base64.StdEncoding.DecodeString(ctB64)
	if err != nil {
		return nil, fmt.Errorf("decode ciphertext: %w", err)
	}

	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("decrypt (version %s): %w", version, err)
	}

	return &DecryptResult{
		Plaintext:  string(plaintext),
		NeedsRekey: version != kr.activeVersion,
		Version:    version,
	}, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
