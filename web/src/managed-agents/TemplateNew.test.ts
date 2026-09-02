import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import { templateInspectionError } from './template-inspection-error'

describe('template inspection errors', () => {
  it('presents a missing root manifest as an invalid template', () => {
    expect(
      templateInspectionError(
        new ApiError(
          'This is not a valid template: oc-template.toml is missing from the repository root.',
          422,
          'template_manifest_missing',
        ),
      ),
    ).toEqual({
      title: 'Not a valid template',
      description:
        'This repository does not contain oc-template.toml at its root.',
    })
  })

  it('keeps a safe fallback for other inspection failures', () => {
    expect(templateInspectionError(new Error('Service unavailable'))).toEqual({
      title: 'This template could not be inspected',
      description: 'Service unavailable',
    })
  })
})
