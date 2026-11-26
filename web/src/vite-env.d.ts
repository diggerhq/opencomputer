/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PUBLIC_POSTHOG_PROJECT_TOKEN?: string
  readonly VITE_PUBLIC_POSTHOG_HOST?: string
  /** Opt-in dev-only flag: serve mock data with no backend/auth (see api/mock.ts). */
  readonly VITE_PREVIEW?: string
  /** With VITE_PREVIEW: the wire the preview's terminal and browser tickets name (a local relay behind a signing proxy). */
  readonly VITE_PREVIEW_WIRE_URL?: string
  /** "0" restores the legacy dashboard and navigation for experiment rollback. */
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
