// The bounded repo snapshot (lane O8) over a real temp directory: it reads source, host config,
// manifests and privacy Markdown, and never `.env*` files, dependencies or build output.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { scanForJobs } from "./detectors/index.js"
import { loadRepoSnapshot } from "./repo-files.js"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "infinite-tag-o8-"))
  dirs.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

describe("loadRepoSnapshot", () => {
  it("reads source, host config, manifests and privacy Markdown, repo-root relative", () => {
    const root = repo({
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "apps/web/package.json": JSON.stringify({ name: "web", dependencies: { next: "15" }, scripts: { build: "next build" } }),
      "apps/web/app/layout.tsx": "export default function L() {}\n",
      "apps/web/vercel.json": "{}",
      "apps/web/content/privacy-policy.mdx": "# Privacy\n",
      "apps/docs/package.json": JSON.stringify({ name: "docs", dependencies: { vite: "5" } })
    })
    const snapshot = loadRepoSnapshot(root, "apps/web")
    expect([...snapshot.files.keys()]).toEqual([
      "apps/docs/package.json",
      "apps/web/app/layout.tsx",
      "apps/web/content/privacy-policy.mdx",
      "apps/web/package.json",
      "apps/web/vercel.json",
      "package.json",
      "pnpm-workspace.yaml"
    ])
    expect(snapshot.appRoot).toBe("apps/web")
    expect(snapshot.packages.find((pkg) => pkg.dir === "apps/web")).toEqual({ dir: "apps/web", name: "web", deps: ["next"], workspaces: [], buildScript: "next build" })
    expect(snapshot.truncated).toBe(false)
  })

  it("never reads .env files, dependencies, build output, or a symlinked file", () => {
    const root = repo({
      "app/page.tsx": "export default function P() {}\n",
      ".env": "SECRET=FAKE-not-a-secret\n",
      ".env.local": "SECRET=FAKE-not-a-secret\n",
      "node_modules/posthog-js/index.js": "posthog.init('x')\n",
      ".next/server/app.js": "x\n",
      "dist/index.html": "<html></html>\n",
      "outside.ts": "export const outside = 1\n"
    })
    symlinkSync(join(root, "outside.ts"), join(root, "app/linked.ts"))
    const paths = [...loadRepoSnapshot(root, ".").files.keys()]
    expect(paths).toEqual(["app/page.tsx", "outside.ts"])
    expect(paths.join("\n")).not.toMatch(/\.env|node_modules|\.next|dist\//)
  })

  it("never follows a symlinked host config or manifest out of the repo (review P3-1, probe P-S)", () => {
    const outside = repo({ "vercel.json": JSON.stringify({ redirects: [{ source: "/a", destination: "/b" }] }), "package.json": "{}" })
    const root = repo({ "app/page.tsx": "export default function P() {}\n" })
    symlinkSync(join(outside, "vercel.json"), join(root, "vercel.json"))
    symlinkSync(join(outside, "package.json"), join(root, "package.json"))
    expect([...loadRepoSnapshot(root, ".").files.keys()]).toEqual(["app/page.tsx"])
  })

  it("feeds the detectors through scanForJobs", () => {
    const root = repo({ "app/api/signup/route.ts": "export async function POST() {\n  await supabase.auth.signUp({ email })\n}\n" })
    const scan = scanForJobs({ root, appRoot: ".", framework: "next-app-router", packageManager: "npm", fileCount: 1, truncated: false })
    expect(scan.detections.outcomes.map((finding) => [finding.file, finding.kind])).toEqual([["app/api/signup/route.ts", "signup"]])
  })
})

it("loads Markdown and template page sources in the bounded snapshot", () => {
  const root = repo({
    "app/terms/page.mdx": 'import Body from "../../components/Body"; export default Body',
    "app/about/page.mdx": 'import Body from "../../components/Body"; export default Body',
    "components/Body.tsx": "export default function Body() { return <p>Shared</p> }",
    "templates/privacy.njk": "---\npermalink: /privacy/\n---\nPolicy text",
  })
  expect([...loadRepoSnapshot(root, ".").files.keys()]).toEqual(["app/about/page.mdx", "app/terms/page.mdx", "components/Body.tsx", "templates/privacy.njk"])
})
