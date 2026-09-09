import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Chromium launches are slow; the visual specs set their own budgets too.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
})
