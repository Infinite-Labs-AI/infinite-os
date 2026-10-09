import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { cleanup, item, makeFenceFixture, POST_INSTALL_LAYOUT, runGit, tempDir, write } from "../../test/wizard/repo.js"
import type { CheckResult, TurnDiff } from "../wizard/contracts/jobs.js"
import { Fence, recoverCrashedTurns, verifySeal } from "./fence.js"
import { snapshotDir, wizardCacheRoot } from "./paths.js"

const RUN_ID = "7f3c2a10-0000-4000-8000-0000000000f1"
// Real git in throwaway repos: give a loaded full-suite run room (review O3 F15).
vi.setConfig({ testTimeout: 30_000 })
const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))

async function begin(prep?: (root: string) => void, files = ["app/layout.tsx", "app/page.tsx", "next.config.mjs"]) {
  const { root } = makeFenceFixture()
  const home = tempDir("fence-hardening-home-")
  dirs.push(root, home)
  prep?.(root)
  const dir = snapshotDir(home, RUN_ID, 1)
  const fence = await Fence.begin({ root, snapshotDir: dir, runId: RUN_ID, turn: 1, items: [item("meta_improve:landing", files)] })
  return { root, home, dir, fence, read: (rel: string) => readFileSync(join(root, rel), "utf8") }
}

const plantFsmonitor = (root: string, sentinel: string) => appendFileSync(join(root, ".git/config"), `[core]\n\tfsmonitor = "touch ${sentinel}; echo"\n`)

describe("F1: the fence never runs agent-planted git config, and undoes agent commits and staging", () => {
  it("a core.fsmonitor planted during the turn does not run in fence.end(), and .git/config is restored", async () => {
    const { root, home, fence, read } = await begin()
    const sentinel = join(home, "fsmonitor-ran")
    plantFsmonitor(root, sentinel)
    write(root, "app/page.tsx", "export default function Page() { return null }\n")
    const result = await fence.end()
    expect(existsSync(sentinel)).toBe(false)
    expect(read(".git/config")).not.toContain("fsmonitor")
    expect(result.reverted).toContain(".git/config")
    expect(result.strays.map((stray) => stray.path)).toContain(".git/config")
  })

  it("a planted hook is deleted before any git call can run it", async () => {
    const { root, home, fence } = await begin()
    const sentinel = join(home, "hook-ran")
    write(root, ".git/hooks/reference-transaction", `#!/bin/sh\ntouch ${sentinel}\n`)
    spawnSync("chmod", ["+x", join(root, ".git/hooks/reference-transaction")])
    runGit(root, ["config", "core.hooksPath", ".git/hooks"])
    // The agent also commits, so the fence's update-ref would trigger a reference-transaction hook.
    write(root, "lib/evil.ts", "export const evil = 1\n")
    runGit(root, ["add", "lib/evil.ts"])
    runGit(root, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "agent", "--", "lib/evil.ts"])
    await fence.end()
    expect(existsSync(sentinel)).toBe(false)
    expect(existsSync(join(root, ".git/hooks/reference-transaction"))).toBe(false)
  })

  it("an agent commit is undone: HEAD back, the committed file outside the allowlist deleted, said as a stray (review P2-3)", async () => {
    const { root, fence } = await begin()
    const headBefore = runGit(root, ["rev-parse", "HEAD"]).trim()
    write(root, "lib/evil.ts", "export const evil = 1\n")
    runGit(root, ["add", "lib/evil.ts"])
    runGit(root, ["commit", "-q", "-m", "agent commit", "--", "lib/evil.ts"])
    const result = await fence.end()
    expect(runGit(root, ["rev-parse", "HEAD"]).trim()).toBe(headBefore)
    expect(existsSync(join(root, "lib/evil.ts"))).toBe(false)
    expect(result.reverted).toContain(".git/refs/heads/main")
    expect(result.strays.map((stray) => stray.path)).toEqual(expect.arrayContaining([".git/refs/heads/main", "lib/evil.ts"]))
    expect(result.edits).toEqual([])
  })

  it("a new branch is deleted and staged bytes leave the index (git show :README.md is HEAD's again)", async () => {
    const { root, fence, read } = await begin()
    runGit(root, ["branch", "agent-side"])
    write(root, "README.md", "# hijacked by the agent\n")
    runGit(root, ["add", "README.md"])
    const result = await fence.end()
    expect(read("README.md")).toBe("# Acme\n")
    expect(runGit(root, ["show", ":README.md"])).toBe("# Acme\n")
    expect(runGit(root, ["branch", "--list", "agent-side"]).trim()).toBe("")
    expect(result.reverted).toEqual(expect.arrayContaining([".git/index", ".git/refs/heads/agent-side"]))
  })
})

describe("F2: a gate hit on a REMOVED line (an old-file line number) reverts the right hunk", () => {
  const lines = Array.from({ length: 12 }, (_, index) => `// line ${index + 1}\n`)
  lines[9] = "fbq('set', 'autoConfig', false, '123456789012345')\n"
  const before = lines.join("")
  const after = [...lines.slice(0, 8), "const a = 1\n", "const b = 2\n", lines[8]!, ...lines.slice(10)].join("")
  const gate = async (diff: TurnDiff): Promise<CheckResult[]> =>
    diff.files.flatMap((file) =>
      file.removed
        .filter((removed) => /autoConfig['"]\s*,\s*false/.test(removed.text))
        .map((removed) => ({ checkId: "turn_gate", state: "problem" as const, tier: "S" as const, reason: "autoconfig_opt_out_removed", evidence: [{ file: file.path, line: removed.line }], at: "x", runId: RUN_ID }))
    )

  it("the opt-out deletion is undone (the line comes back)", async () => {
    const { root, fence, read } = await begin((r) => write(r, "app/page.tsx", before))
    write(root, "app/page.tsx", after)
    const result = await fence.end({ turnGate: gate })
    // §3x.2 A gate hit is not a block: the hunk is reverted and reported as a gate hit.
    expect(result.blocked).toEqual([])
    // The old-file line could sit in either hunk's range, so each such hunk is reverted and reported.
    expect(result.gateHits.length).toBeGreaterThan(0)
    expect(new Set(result.gateHits.map((hit) => hit.rule))).toEqual(new Set(["autoconfig_opt_out_removed"]))
    expect(read("app/page.tsx")).toContain("fbq('set', 'autoConfig', false, '123456789012345')")
  })
})

describe("F3: a consent change on a continuation line of a multi-line consent call is caught", () => {
  const layout = "export function Consent() {\n  gtag('consent', 'default', {\n    ad_storage: 'denied',\n    analytics_storage: 'denied',\n  })\n  return null\n}\n"

  it("flipping ad_storage inside gtag('consent','default',{…}) is reverted and blocks the job consent_touched", async () => {
    const { root, fence, read } = await begin((r) => write(r, "app/page.tsx", layout))
    write(root, "app/page.tsx", layout.replace("ad_storage: 'denied'", "ad_storage: 'granted'"))
    const result = await fence.end()
    expect(result.blocked.map((block) => block.reason)).toContain("consent_touched")
    expect(read("app/page.tsx")).toBe(layout)
  })

  it("a consent key on a line of its own inside dataLayer.push([...]) is caught too, but an unrelated hunk is kept", async () => {
    const text = "window.dataLayer.push([\n  'consent',\n  'update',\n  {\n    ads: 'denied'\n  }\n])\nexport const x = 1\n"
    const { root, fence, read } = await begin((r) => write(r, "app/page.tsx", text))
    write(root, "app/page.tsx", text.replace("ads: 'denied'", "ads: 'granted'").replace("export const x = 1", "export const x = 2"))
    const result = await fence.end()
    expect(result.blocked.map((block) => block.reason)).toContain("consent_touched")
    expect(read("app/page.tsx")).toContain("ads: 'denied'")
    expect(read("app/page.tsx")).toContain("export const x = 2")
  })
})

describe("F9: a throwing gate never leaves the turn half-settled", () => {
  it("the whole turn is restored, the snapshot deleted, and the error goes on", async () => {
    const { root, dir, fence, read } = await begin()
    const before = read("app/layout.tsx")
    const pageBefore = read("app/page.tsx")
    write(root, "app/layout.tsx", `export const x = 1\n${POST_INSTALL_LAYOUT}gtag('consent', 'update', { ad_storage: 'granted' })\n`)
    // The consent edit is restored first; an independent ordinary edit still reaches the gate.
    write(root, "app/page.tsx", "export default function Page() { return null }\n")
    await expect(fence.end({ turnGate: async () => { throw new Error("gate crashed") } })).rejects.toThrow("gate crashed")
    expect(read("app/layout.tsx")).toBe(before)
    expect(read("app/page.tsx")).toBe(pageBefore)
    expect(existsSync(join(dir, "manifest.json"))).toBe(false)
  })
})

describe("F10: a turn a dead process left open is restored by recoverCrashedTurns", () => {
  it("restores the agent's edits and deletes the snapshot; a live process's turn and report-mode snapshots are left alone", async () => {
    const { root, home, dir, read } = await begin()
    const before = read("app/page.tsx")
    write(root, "app/page.tsx", "// the agent's unvetted edit\n")
    // The process that owned the turn is dead:
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" })
    const manifestPath = join(dir, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { pid: number }
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, pid: Number(dead.stdout) }))
    const recovered = await recoverCrashedTurns({ snapshotsRoot: join(wizardCacheRoot(home), "snapshots"), root })
    expect(recovered.map((entry) => entry.dir)).toEqual([dir])
    expect(read("app/page.tsx")).toBe(before)
    expect(existsSync(dir)).toBe(false)
  })
})

describe("F11: the seal catches a write after the turn settled", () => {
  it("a file written after fence.end() fails verifySeal; an untouched tree passes", async () => {
    const { root, fence } = await begin()
    write(root, "app/page.tsx", "export default function Page() { return null }\n")
    const { seal } = await fence.end()
    expect(await verifySeal(seal)).toEqual({ ok: true, changed: [] })
    // The wizard's own state writes do not count:
    write(root, ".infinite/wizard/state.json", "{}\n")
    expect((await verifySeal(seal)).ok).toBe(true)
    write(root, "next.config.mjs", "require('child_process')\n")
    expect(await verifySeal(seal)).toEqual({ ok: false, changed: ["next.config.mjs"] })
  })
})
