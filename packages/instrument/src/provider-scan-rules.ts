// Shared scan exclusions. Keep this module dependency-free so scanner entry points can load independently.
/**
 * Files that carry provider signatures WITHOUT being an install: minified vendor bundles, type
 * declarations (`declare function gtag(`), tests/specs/stories/mocks (`posthog.init('phc_test')`).
 * A false positive here silently drops a provider from the install as "adopted" — the worse failure.
 */
export const providerScanSkippedFiles = /(?:^test[-_.]|\.(?:d\.ts|(?:test|spec|stories)\.[cm]?[jt]sx?|min\.[cm]?js)$)/
/** Directories the walk never enters: dependencies, build output, VCS, coverage, static assets, tests, mocks, email templates. */
export const providerScanSkippedDirectories = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  ".vercel",
  "coverage",
  "public",
  "static",
  "__tests__",
  "__mocks__",
  ".storybook",
  "emails"
])
