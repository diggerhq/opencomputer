/**
 * The single-VM self-hosted build (`VITE_SELFHOST=1`, selfhost/gateway). It has no
 * billing: no plans, credits, upsells or billing pages.
 */
export const SELFHOST = import.meta.env.VITE_SELFHOST === '1'
