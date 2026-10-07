// The fence against an agent that reaches for git, multi-line consent calls, removed-line gate hits, a
// throwing gate, a BOM, a deleted heavy dir, a crashed turn and a write after the turn (review O3 F1-F3,
// F9-F11, F17, F18). Each case failed before the fix; real git in throwaway repos, no network.
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { cleanup, item, makeFenceFixture, POST_INSTALL_LAYOUT, runGit, tempDir, write } from "../../test/wizard/repo.js"
import { reverseTextEdits } from "../server-lane/text-edits.js"
import type { CheckResult, TurnDiff } from "../wizard/contracts/jobs.js"
import { consentLineSpans, Fence, recoverCrashedTurns, verifySeal } from "./fence.js"
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

  it("…nor in abort() (out of usage, timeout, SIGINT)", async () => {
    const { root, home, fence, read } = await begin()
    const sentinel = join(home, "fsmonitor-ran-on-abort")
    plantFsmonitor(root, sentinel)
    const result = await fence.abort()
    expect(existsSync(sentinel)).toBe(false)
    expect(read(".git/config")).not.toContain("fsmonitor")
    expect(result.restored).toContain(".git/config")
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

  it("assume-unchanged on a tracked file cannot hide an edit from the fence", async () => {
    const { root, fence, read } = await begin()
    runGit(root, ["update-index", "--assume-unchanged", "README.md"])
    write(root, "README.md", "# hidden edit\n")
    const result = await fence.end()
    expect(read("README.md")).toBe("# Acme\n")
    expect(result.reverted).toContain("README.md")
  })

  it("control: a turn that never touched git reverts nothing under .git and keeps the allowed edit", async () => {
    const { root, fence } = await begin()
    write(root, "app/page.tsx", "export default function Page() { return null }\n")
    const result = await fence.end()
    expect(result.reverted.filter((rel) => rel.startsWith(".git"))).toEqual([])
    expect(result.edits.map((edit) => edit.file)).toEqual(["app/page.tsx"])
    expect(result.blocked).toEqual([])
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

  it("control: with no gate hit both hunks are kept", async () => {
    const { root, fence, read } = await begin((r) => write(r, "app/page.tsx", before))
    write(root, "app/page.tsx", after)
    await fence.end({ turnGate: async () => [] })
    expect(read("app/page.tsx")).toBe(after)
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

  it("consentLineSpans: the span covers the whole call and stops at its closing bracket (strings with brackets skipped)", () => {
    const text = "a()\ngtag('consent', 'default', {\n  label: ')',\n  ad_storage: 'denied'\n})\nb()\n"
    expect(consentLineSpans(text)).toEqual([[2, 5]])
    expect(consentLineSpans("const x = 1\n")).toEqual([])
  })

  it("freezes the complete function containing a multi-line consent call, including its return", async () => {
    const { root, fence, read } = await begin((r) => write(r, "app/page.tsx", layout))
    const next = layout.replace("  return null\n", "  return <span />\n")
    write(root, "app/page.tsx", next)
    const result = await fence.end()
    expect(result.blocked.map(block => block.reason)).toContain("consent_touched")
    expect(read("app/page.tsx")).toBe(layout)
  })

  it("keeps an edit in a separate top-level unit beside the frozen call", async () => {
    const before = layout + "export const title = 'before';\n"
    const { root, fence, read } = await begin(r => write(r, "app/page.tsx", before))
    const after = before.replace("title = 'before'", "title = 'after'")
    write(root, "app/page.tsx", after)
    expect((await fence.end()).blocked).toEqual([])
    expect(read("app/page.tsx")).toBe(after)
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

describe("F17: a UTF-8 BOM survives the fence", () => {
  it("beforeHash is the file's real hash and textEdits reverse to the exact original bytes", async () => {
    const original = "﻿export default function Page() {\n  return null\n}\n"
    const { root, fence } = await begin((r) => write(r, "app/page.tsx", original))
    const realBefore = readFileSync(join(root, "app/page.tsx"))
    write(root, "app/page.tsx", `${original}export const x = 1\n`)
    const result = await fence.end()
    const edit = result.edits.find((entry) => entry.file === "app/page.tsx")!
    expect(edit.beforeHash).toBe(`sha256:${createHash("sha256").update(realBefore).digest("hex")}`)
    expect(reverseTextEdits(readFileSync(join(root, "app/page.tsx"), "utf8"), edit.textEdits)).toBe(original)
  })
})

describe("F18: deleting a whole heavy dir is tamper", () => {
  it("rm -rf node_modules during the turn → INF_WIZ_FENCE_TAMPER", async () => {
    const { root, fence } = await begin()
    rmSync(join(root, "node_modules"), { recursive: true, force: true })
    await expect(fence.end()).rejects.toMatchObject({ code: "INF_WIZ_FENCE_TAMPER" })
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

  it("negative: this process's own open turn is not touched", async () => {
    const { root, home, dir, read } = await begin()
    write(root, "app/page.tsx", "// still mid-turn\n")
    expect(await recoverCrashedTurns({ snapshotsRoot: join(wizardCacheRoot(home), "snapshots"), root })).toEqual([])
    expect(read("app/page.tsx")).toBe("// still mid-turn\n")
    expect(existsSync(dir)).toBe(true)
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

  it("a late write inside node_modules or a planted hook fails it too", async () => {
    const { root, fence } = await begin()
    const { seal } = await fence.end()
    write(root, "node_modules/next/evil.js", "x\n")
    expect((await verifySeal(seal)).changed).toContain("node_modules/next/evil.js")
    expect((await verifySeal(seal, { heavy: false })).ok).toBe(true)
    write(root, ".git/hooks/pre-commit", "#!/bin/sh\n")
    expect((await verifySeal(seal, { heavy: false })).changed).toContain(".git/hooks/pre-commit")
  })
})
