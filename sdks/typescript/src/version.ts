// The SDK's own identity, sent on the two requests that decide which runtime
// serves a customer: creating a sandbox and creating a template.
//
// This is what makes self-service migration possible. An org that has not been
// pinned to a runtime lands on the MicroVM backend when it calls with a 1.x SDK
// and on the QEMU fleet when it calls with an older one — so upgrading the
// dependency IS the migration, and pinning the old version is the rollback.
// Nothing has to be changed in our database for either direction.
//
// 1.0.0, not 2.0.0, even though the docs call this platform generation "v2":
// every version this package has ever published is 0.x, so 1.0.0 is both the
// first stable release and a clean major break from all of them. The product
// generation and the package major are not the same number.
//
// Only the MAJOR is load-bearing: the server compares it against a minimum, so
// patch and minor releases never move anyone.

/** Header carrying the version below. Lower-case: HTTP/2 requires it. */
export const SDK_VERSION_HEADER = "x-oc-sdk-version";

/**
 * This package's version.
 *
 * Kept as a literal rather than read from package.json, because the SDK ships
 * as an ESM bundle that may be consumed by bundlers where a JSON import is not
 * resolvable. version.test.ts asserts it matches package.json, which is the
 * only failure mode that matters — a stale constant here would silently route a
 * v2 caller to the old runtime.
 */
export const SDK_VERSION = "1.1.0";

/** The identifying header, as a spreadable object. */
export function sdkVersionHeaders(): Record<string, string> {
  return { [SDK_VERSION_HEADER]: SDK_VERSION };
}
