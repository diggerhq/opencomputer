// Package webhook implements the signing and SSRF-defense primitives for
// outbound sandbox lifecycle webhooks. It mirrors the Standard Webhooks scheme
// (https://www.standardwebhooks.com) used by sessions-api so a recipient can
// verify deliveries from either product with one verifier.
//
// The one deliberate difference from sessions-api today: the `webhook-id`
// header is the *delivery* id (stable across retries and manual redelivery),
// not the event id — see .agents/work/sandbox-lifecycle-webhooks.md §7.
package webhook

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"strconv"
	"strings"
)

// SecretPrefix is the conventional Standard Webhooks secret prefix.
const SecretPrefix = "whsec_"

// secretBytes is the number of random bytes behind a generated secret.
const secretBytes = 32

// GenerateSecret mints a new signing secret: "whsec_" + standard base64 of 32
// random bytes. Standard (not URL) base64 is deliberate (the shipped TS
// verifier decodes with atob, which doesn't reliably accept base64url).
func GenerateSecret() (string, error) {
	buf := make([]byte, secretBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return SecretPrefix + base64.StdEncoding.EncodeToString(buf), nil
}

// SecretKeyBytes decodes a Standard Webhooks secret to its raw HMAC key bytes:
// strip the "whsec_" prefix and base64-decode. If the remainder isn't valid
// base64, fall back to the raw UTF-8 bytes of the original secret (mirrors
// sessions-api egress.ts:secretKeyBytes, so caller-supplied non-base64 secrets
// still work identically across products).
func SecretKeyBytes(secret string) []byte {
	s := strings.TrimPrefix(secret, SecretPrefix)
	if b, err := base64.StdEncoding.DecodeString(s); err == nil && len(b) > 0 {
		// Round-trip guard: only treat it as base64 if re-encoding matches
		// (ignoring padding), so arbitrary strings that happen to decode don't
		// silently change the key bytes.
		if strings.TrimRight(base64.StdEncoding.EncodeToString(b), "=") == strings.TrimRight(s, "=") {
			return b
		}
	}
	return []byte(secret)
}

// Sign returns the `webhook-signature` header value for a delivery:
//
//	v1,<base64(HMAC-SHA256(key, "{webhookID}.{timestamp}.{rawBody}"))>
//
// webhookID is the delivery id (our contract; §7); timestamp is unix seconds.
// rawBody MUST be the exact bytes that go on the wire — sign before any
// re-serialization.
func Sign(secret, webhookID string, timestamp int64, rawBody []byte) string {
	mac := hmac.New(sha256.New, SecretKeyBytes(secret))
	mac.Write([]byte(webhookID))
	mac.Write([]byte("."))
	mac.Write([]byte(strconv.FormatInt(timestamp, 10)))
	mac.Write([]byte("."))
	mac.Write(rawBody)
	return "v1," + base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// Headers builds the full set of HTTP headers for a signed delivery POST. The
// dispatcher and the synchronous /test endpoint both use this so the wire
// format is defined in exactly one place.
//
//   - webhook-id        = deliveryID (recipients dedupe on this)
//   - webhook-timestamp = unix seconds (replay guard)
//   - webhook-signature = Sign(...)
//   - X-OC-Delivery-ID / X-OC-Sandbox-ID for correlation
func Headers(secret, deliveryID, sandboxID string, timestamp int64, rawBody []byte) map[string]string {
	return map[string]string{
		"Content-Type":      "application/json",
		"User-Agent":        "OpenComputer-Webhooks/1",
		"webhook-id":        deliveryID,
		"webhook-timestamp": strconv.FormatInt(timestamp, 10),
		"webhook-signature": Sign(secret, deliveryID, timestamp, rawBody),
		"X-OC-Delivery-ID":  deliveryID,
		"X-OC-Sandbox-ID":   sandboxID,
	}
}
