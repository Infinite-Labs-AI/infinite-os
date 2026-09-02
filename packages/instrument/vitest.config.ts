import { defineConfig } from "vitest/config"

// Package-local config so `vitest run` (e.g. `pnpm --filter infinite-tag test`, and publish.yml)
// discovers this package's suite. Without it, vitest walks up to the ROOT config whose include is
// repo-root-relative (`packages/**/*.test.ts`), which resolves to nothing when the cwd is this
// package — silently running ZERO tests. The include below is relative to this package's root.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"]
  }
})
