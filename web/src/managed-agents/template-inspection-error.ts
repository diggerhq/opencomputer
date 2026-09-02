import { ApiError } from '@/api/client'

export function templateInspectionError(error: unknown) {
  if (error instanceof ApiError && error.type === 'template_manifest_missing') {
    return {
      title: 'Not a valid template',
      description:
        'This repository does not contain oc-template.toml at its root.',
    }
  }
  return {
    title: 'This template could not be inspected',
    description:
      error instanceof Error
        ? error.message
        : 'Check the repository and try again.',
  }
}
