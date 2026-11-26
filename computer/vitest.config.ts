import { defineConfig } from 'vitest/config';

// Unit tests sit next to the code as `<file>.test.ts`. The integration checks
// in src/dev/*-check.ts spawn real processes and are run by hand (see README).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
