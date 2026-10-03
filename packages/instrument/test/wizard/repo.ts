// Test helper (never published): throwaway git repos and homes for the agent-runner tests. Every repo is
// a real `git init` in a temp dir with an author set locally, so the fence's git status/ls-files/cat-file
// calls run against real git. No network.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { ChecklistItem } from "../../src/wizard/contracts/jobs.js"

export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

export function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_TERMINAL_PROMPT: "0"
    }
  })
}

export function write(root: string, rel: string, text: string): void {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

export const HEAD_PACKAGE_JSON = `{\n  "name": "acme-store",\n  "private": true,\n  "dependencies": { "next": "16.0.0" }\n}\n`
export const POST_INSTALL_PACKAGE_JSON = `{\n  "name": "acme-store",\n  "private": true,\n  "dependencies": { "@vercel/functions": "2.0.0", "next": "16.0.0" }\n}\n`
export const HEAD_LAYOUT = [
  "import './globals.css'",
  "",
  "export default function RootLayout({ children }) {",
  "  return (",
  "    <html lang=\"en\">",
  "      <body>{children}</body>",
  "    </html>",
  "  )",
  "}",
  ""
].join("\n")
export const POST_INSTALL_LAYOUT = HEAD_LAYOUT.replace(
  "import './globals.css'",
  "import './globals.css'\nimport { InfiniteAnalytics } from '../lib/infinite/analytics'"
)
export const MANAGED_MODULE = "// infinite-tag managed\nexport function InfiniteAnalytics() { return null }\n"
export const GITIGNORE_FENCE = "\n# infinite-tag:start\n.infinite/wizard/\n# infinite-tag:end\n"

/**
 * The fence fixture (§O3 acceptance): a committed Next app, then the state `install` leaves before the
 * agent turn: UNCOMMITTED managed edits, an npm-edited package.json + lockfile, the gitignore fence, an
 * untracked managed module, plus the ignored `.env.local`, `.infinite/wizard/state.json`,
 * `.claude/settings.local.json` and a `node_modules` package.
 */
export function makeFenceFixture(): { root: string } {
  const root = tempDir("infinite-tag-fence-repo-")
  runGit(root, ["init", "-q", "-b", "main"])
  write(root, ".gitignore", "node_modules/\n.env*\n.next/\n.claude/settings.local.json\n")
  write(root, "package.json", HEAD_PACKAGE_JSON)
  write(root, "package-lock.json", '{ "lockfileVersion": 3, "packages": {} }\n')
  write(root, "app/layout.tsx", HEAD_LAYOUT)
  write(root, "app/page.tsx", "export default function Page() {\n  return <a href=\"/signup\">Start free trial</a>\n}\n")
  write(root, "app/privacy/page.tsx", "export default function Privacy() {\n  return <p>We respect your privacy.</p>\n}\n")
  write(root, "next.config.mjs", "const nextConfig = {}\n\nexport default nextConfig\n")
  write(root, "README.md", "# Acme\n")
  runGit(root, ["add", "-A"])
  runGit(root, ["commit", "-q", "-m", "init"])
  // What `install` left uncommitted:
  write(root, "app/layout.tsx", POST_INSTALL_LAYOUT)
  write(root, "lib/infinite/analytics.ts", MANAGED_MODULE)
  write(root, "package.json", POST_INSTALL_PACKAGE_JSON)
  write(root, "package-lock.json", '{ "lockfileVersion": 3, "packages": { "node_modules/@vercel/functions": {} } }\n')
  write(root, ".gitignore", `node_modules/\n.env*\n.next/\n.claude/settings.local.json\n${GITIGNORE_FENCE}`)
  write(root, ".infinite/install.json", '{ "schemaVersion": 1 }\n')
  // Ignored paths:
  write(root, ".env.local", "SECRET_SITE_VALUE=fixture-not-a-secret\n")
  write(root, ".infinite/wizard/state.json", '{ "schema": "infinite-tag.wizard-state.v1" }\n')
  write(root, ".claude/settings.local.json", '{ "permissions": {} }\n')
  write(root, "node_modules/next/package.json", '{ "name": "next" }\n')
  return { root }
}

export function item(id: string, files: string[], create: string[] = []): ChecklistItem {
  const [jobId] = id.split(":") as [ChecklistItem["jobId"]]
  return {
    id,
    jobId,
    n: 5,
    title: `Job ${id}`,
    owner: "agent",
    trigger: { finding: "fixture", evidence: [{ file: files[0] ?? "app/layout.tsx", line: 1 }] },
    allow: { files, create },
    checks: [],
    state: "pending"
  }
}

export function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}
