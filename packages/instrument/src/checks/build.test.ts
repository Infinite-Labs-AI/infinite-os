// The build check (lane O6): through sandboxedSpawn (a spy here; no real build, no network), and the
// baseline-vs-new failure signature. Each verdict has a negative.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import type { SandboxedSpawnFn, SandboxedSpawnOptions, SandboxedSpawnResult } from "../t0/sandbox.js"
import { buildPackageManager, failureSignature, gradeBuild, runBuild } from "./build.js"

const ctx = { runId: "7f3c2a91-b0de-4c03-9a00-000000000001", now: () => new Date("2026-10-02T10:00:00.000Z") }

function site(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "build-check-"))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

function spy(answer: Partial<SandboxedSpawnResult>): { fn: SandboxedSpawnFn; calls: Array<{ cmd: string; args: readonly string[]; options: SandboxedSpawnOptions }> } {
  const calls: Array<{ cmd: string; args: readonly string[]; options: SandboxedSpawnOptions }> = []
  const fn: SandboxedSpawnFn = async (cmd, args, options) => {
    calls.push({ cmd, args, options })
    return { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, sandboxed: true, pid: 4242, stdoutTruncated: false, stderrTruncated: false, ...answer }
  }
  return { fn, calls }
}

const NEXT_TYPE_ERROR = (root: string, line: number) => `
> acme@0.1.0 build
> next build

   ▲ Next.js 15.5.0
   Creating an optimized production build ...
 ✓ Compiled successfully in 4.2s
Failed to compile.

${root}/app/page.tsx:${line}:7
Type error: Type 'number' is not assignable to type 'string'.
`

describe("runBuild goes through sandboxedSpawn, never the wizard's process", () => {
  it("runs `<pm> run build` in the app root with network ON, the read denies, and telemetry off", async () => {
    const root = site({ "apps/web/package.json": JSON.stringify({ scripts: { build: "next build" } }), "pnpm-lock.yaml": "" })
    const { fn, calls } = spy({ exitCode: 0 })
    const run = await runBuild({ root, appRoot: "apps/web", spawn: fn, denyReads: { paths: ["/Users/x/.ssh"], prefixes: ["/Users/x/.growth-os"] } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.cmd).toBe("pnpm")
    expect(calls[0]!.args).toEqual(["run", "build"])
    expect(calls[0]!.options).toMatchObject({ network: true, cwd: join(root, "apps/web"), denyReads: ["/Users/x/.ssh"], denyReadPrefixes: ["/Users/x/.growth-os"] })
    expect(calls[0]!.options.env).toMatchObject({ NEXT_TELEMETRY_DISABLED: "1" })
    expect(run).toMatchObject({ ok: true, sandboxed: true, packageManager: "pnpm", failureSignature: [] })
  })

  it("negative: no build script means nothing ran (info), never a green build", async () => {
    const root = site({ "package.json": JSON.stringify({ scripts: { dev: "vite" } }) })
    const { fn, calls } = spy({})
    const run = await runBuild({ root, appRoot: ".", spawn: fn })
    expect(calls).toHaveLength(0)
    expect(run.skipped).toBe("no_build_script")
    expect(gradeBuild("build", run, null, ctx).state).toBe("info")
  })

  it("picks the app's lockfile, then the repo root's, then npm; refuses to guess between two lockfiles", () => {
    expect(buildPackageManager(site({ "yarn.lock": "" }), "/x")).toBe("yarn")
    const mono = site({ "pnpm-lock.yaml": "", "apps/web/package.json": "{}" })
    expect(buildPackageManager(mono, join(mono, "apps/web"))).toBe("pnpm")
    expect(buildPackageManager(site({ "package.json": "{}" }), "/nope")).toBe("npm")
    expect(buildPackageManager(site({ "package-lock.json": "", "yarn.lock": "" }), "/nope")).toBe("ambiguous")
  })

  it("a deadline or a sandbox that cannot be applied is undetermined, never a pass", async () => {
    const root = site({ "package.json": JSON.stringify({ scripts: { build: "x" } }) })
    const timedOut = await runBuild({ root, appRoot: ".", spawn: spy({ exitCode: null, timedOut: true }).fn })
    expect(gradeBuild("build", timedOut, null, ctx).state).toBe("undetermined")
    const unavailable = await runBuild({
      root,
      appRoot: ".",
      spawn: async () => {
        throw new Error("macOS sandbox-exec could not apply a profile")
      }
    })
    expect(gradeBuild("build", unavailable, null, ctx)).toMatchObject({ state: "undetermined", reason: expect.stringContaining("sandbox-exec") })
  })
})

describe("the failure signature tells a new failure from the baseline's", () => {
  it("strips the repo path, line:column and timings, so the same error after an edit is the same failure", () => {
    expect(failureSignature(NEXT_TYPE_ERROR("/Users/x/site", 12), "/Users/x/site")).toEqual(failureSignature(NEXT_TYPE_ERROR("/Users/x/site", 40), "/Users/x/site"))
    expect(failureSignature("src/a.ts(3,5): error TS2322: Type 'x' is not assignable\nFound 0 errors in 1.2s", "/r")).toEqual(["src/a.ts: error TS2322: Type 'x' is not assignable"])
  })

  it("baseline red with the same failure → pass (reported, not blamed); a new failure → problem", async () => {
    const root = site({ "package.json": JSON.stringify({ scripts: { build: "next build" } }) })
    const baseline = await runBuild({ root, appRoot: ".", spawn: spy({ exitCode: 1, stdout: NEXT_TYPE_ERROR(root, 12) }).fn })
    expect(baseline.ok).toBe(false)
    const same = await runBuild({ root, appRoot: ".", spawn: spy({ exitCode: 1, stdout: NEXT_TYPE_ERROR(root, 14) }).fn })
    expect(gradeBuild("build_green_or_baseline", same, baseline, ctx).state).toBe("pass")
    const worse = await runBuild({ root, appRoot: ".", spawn: spy({ exitCode: 1, stdout: `${NEXT_TYPE_ERROR(root, 14)}\nModule not found: Can't resolve './infinite-analytics'\n` }).fn })
    const graded = gradeBuild("build_green_or_baseline", worse, baseline, ctx)
    expect(graded).toMatchObject({ state: "problem", tier: "B", runId: ctx.runId })
    expect(graded.reason).toContain("Module not found")
    expect(graded.reason).not.toContain(root)
  })

  it("negative: a green baseline makes ANY failure new; no baseline and red is a problem too", async () => {
    const root = site({ "package.json": JSON.stringify({ scripts: { build: "next build" } }) })
    const green = await runBuild({ root, appRoot: ".", spawn: spy({ exitCode: 0 }).fn })
    const red = await runBuild({ root, appRoot: ".", spawn: spy({ exitCode: 2, stderr: "the process died without a message" }).fn })
    expect(red.failureSignature).toEqual(["exit_code:2"])
    expect(gradeBuild("build", red, green, ctx).state).toBe("problem")
    expect(gradeBuild("build", red, null, ctx).state).toBe("problem")
    expect(gradeBuild("build", green, null, ctx).state).toBe("pass")
  })
})
