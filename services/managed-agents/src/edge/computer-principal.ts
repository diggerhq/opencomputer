/**
 * The organization's computer as a caller (work 080). The
 * edge marks an assertion minted for a computer key with `principal:
 * "computer"` and, when the host named one, the Slack session it was minted
 * for. A computer may use what the organization has granted it; it never
 * connects, attaches or grants credentials itself: a person does that from
 * Slack or the dashboard. The edge refuses these routes first; this is the
 * same list, so a missed edge rule is not enough.
 */

export const COMPUTER_PRINCIPAL = "computer";

const FETCH_ROUTE = /^\/v1\/connections\/[^/]+\/fetch$/;

export function isComputerGrantRoute(method: string, pathname: string): boolean {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return false;
  if (/^\/v1\/connections(?:\/|$)/.test(pathname)) {
    return !(verb === "POST" && FETCH_ROUTE.test(pathname));
  }
  return (
    /^\/v1\/projects\/[^/]+\/service-connections$/.test(pathname) ||
    pathname === "/v1/computer/service-connections" ||
    /^\/v1\/(?:projects\/[^/]+\/)?model-access(?:\/|$)/.test(pathname) ||
    pathname.startsWith("/v1/linear/") ||
    /^\/v1\/projects\/[^/]+\/linear(?:\/|$)/.test(pathname) ||
    /^\/v1\/channels(?:\/|$)/.test(pathname) ||
    pathname === "/v1/channel-connections/claim" ||
    pathname === "/v1/github/connect" ||
    /^\/v1\/projects\/[^/]+\/github(?:\/(?:connect|attach))?$/.test(pathname)
  );
}
