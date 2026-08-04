package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

// VM-DO connect token (vm_do_datapane_validation): the credential the QEMU worker
// host presents when it dials a sandbox's VmSession Durable Object on the edge.
//
// It is a per-sandbox HMAC over the sandbox id, keyed by SESSION_JWT_SECRET — the
// secret the edge and CP already share (the CP mints it, the edge re-verifies).
// The worker never holds the signing key, only this derived token, so a
// compromised worker can hijack at most the one channel it was handed, never
// forge a token for another sandbox. The "vmdo:" domain prefix keeps it from
// colliding with any other HMAC use of the same secret.
//
// The edge's verifier (cloudflare-workers/api-edge/src/index.ts) recomputes this
// exact construction — keep the two in lockstep: lower-hex(HMAC_SHA256(secret,
// "vmdo:"+id)).
func MintVMDOConnectToken(sessionJWTSecret, sandboxID string) string {
	if sessionJWTSecret == "" || sandboxID == "" {
		return ""
	}
	mac := hmac.New(sha256.New, []byte(sessionJWTSecret))
	mac.Write([]byte("vmdo:" + sandboxID))
	return hex.EncodeToString(mac.Sum(nil))
}
