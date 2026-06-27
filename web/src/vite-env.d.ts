/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PUBLIC_POSTHOG_PROJECT_TOKEN?: string
  readonly VITE_PUBLIC_POSTHOG_HOST?: string
  /** Opt-in dev-only flag: serve mock data with no backend/auth (see api/mock.ts). */
  readonly VITE_PREVIEW?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
