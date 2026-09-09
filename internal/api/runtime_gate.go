package api

// runtime_gate.go — routing a create by the SDK that asked for it.
//
// orgs.runtime used to be the only answer to "which runtime serves this org",
// and we set it by hand, one org at a time. That is not a migration: it makes us
// the bottleneck for every customer who wants to move and every customer who
// wants to move back.
//
// So the column is now a PIN, and the calling SDK's major version decides for
// everyone who is not pinned:
//
//	orgs.runtime = 'microvm'  ->  MicroVM, whatever SDK is calling
//	orgs.runtime = 'qemu'     ->  QEMU, whatever SDK is calling
//	orgs.runtime empty        ->  the SDK decides: 1.x+ MicroVM, 0.x QEMU
//
// This file is the CELL's half. The edge decides first and puts the answer in
// the capability token (cloudflare-workers/api-edge/src/runtime_gate.ts); this
// only fires for a create that reached a cell WITHOUT a token — the
// direct-to-cell path, authenticated with an API key against this cell. Both
// halves have to agree, or the same SDK gets a different runtime depending on
// which door it came in.

import (
	"os"
	"strconv"
	"strings"

	"github.com/labstack/echo/v4"
)

// sdkVersionHeader is what the TypeScript SDK sends its own version in. Kept in
// sync with sdks/typescript/src/version.ts by hand — there is no shared
// artifact between a Go binary and an npm package, and runtime_gate_test.go
// pins the string on this side.
const sdkVersionHeader = "X-OC-SDK-Version"

// defaultMinSDKMajor is the major at and above which an SDK routes to MicroVM.
//
// 1, because every version @opencomputer/sdk has ever published is 0.x — the
// first stable release is therefore also an exact split between everything that
// exists today and the new one. The docs call this platform generation "v2";
// the package major is 1, and nothing here should assume they match.
//
// Overridable because the version this ships under is a release decision that
// can change after this code is written, and getting it wrong should cost an
// env var rather than a re-release of the SDK.
const defaultMinSDKMajor = 1

// sdkMajor is the major version from the request's SDK header, or 0.
//
// 0 for absent, malformed, or non-numeric — every one of which means "a client
// that does not announce itself", which is exactly the population that must keep
// landing on QEMU. Unparseable input has to fail toward the old runtime.
func sdkMajor(c echo.Context) int {
	raw := strings.TrimSpace(c.Request().Header.Get(sdkVersionHeader))
	if raw == "" {
		return 0
	}
	major, err := strconv.Atoi(strings.SplitN(raw, ".", 2)[0])
	if err != nil || major <= 0 {
		return 0
	}
	return major
}

// sdkRuntimeGateEnabled reports whether SDK-version routing is on.
//
// OPENSANDBOX_SDK_RUNTIME_GATE=0 pins every unpinned org back to QEMU without
// touching a single org row — the kill switch for self-service migration.
func sdkRuntimeGateEnabled() bool {
	return os.Getenv("OPENSANDBOX_SDK_RUNTIME_GATE") != "0"
}

// runtimeForSDK returns the runtime an UNPINNED org's create belongs on, given
// only the calling SDK. "" means the QEMU fleet.
//
// Callers must have established that the org has no pin first: a pin wins in
// both directions, and this function cannot see one.
func runtimeForSDK(c echo.Context) string {
	if !sdkRuntimeGateEnabled() {
		return ""
	}
	min := envInt("OPENSANDBOX_SDK_RUNTIME_MIN_MAJOR", defaultMinSDKMajor)
	if min <= 0 {
		min = defaultMinSDKMajor
	}
	if sdkMajor(c) >= min {
		return runtimeMicrovm
	}
	return ""
}
