// The build check (lane O6): through sandboxedSpawn (a spy here; no real build, no network), and the
// baseline-vs-new failure signature. Each verdict has a negative.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import type { SandboxedSpawnFn, SandboxedSpawnOptions, SandboxedSpawnResult } from "../t0/sandbox.js"
import { buildAllowedWrites, buildDeniedWrites, gradeBuild, installSiteDependencies, runBuild } from "./build.js"

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
    return { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, sandboxed: true, pid: 4242, home: "/private/var/folders/x1/T/infinite-tag-sbx-AAAA11", stdoutTruncated: false, stderrTruncated: false, ...answer }
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
  it("installs frozen dependencies through the network-enabled sandbox and streams progress", async () => {
    const root = site({ "pnpm-lock.yaml": "" })
    const calls: string[] = []
    const output: string[] = []
    const fake = spy({})
    const result = await installSiteDependencies({ root, appRoot: ".", onOutput: (line) => output.push(line), spawn: async (cmd, args, options) => {
      calls.push(`${cmd} ${args.join(" ")}`)
      if (args[0] === "store") {
        expect(options.network).toBe(false)
        return { ...await fake.fn(cmd, args, options), stdout: "/fixture-cache/store/v10\n" }
      }
      expect(options.network).toBe(true)
      expect(options.allowWrites).toContain(join(root, "node_modules"))
      expect(options.allowWrites).not.toContain(root)
      options.onOutput?.("Progress: installed", "stdout")
      return fake.fn(cmd, args, options)
    } })
    expect(result.ok).toBe(true)
    expect(calls).toEqual(["pnpm store path", "pnpm install --frozen-lockfile --store-dir /fixture-cache/store"])
    expect(output).toEqual(["Progress: installed"])
  })

  it("runs `<pm> run build` in the app root with network ON, the read denies, and telemetry off", async () => {
    const root = site({ "apps/web/package.json": JSON.stringify({ scripts: { build: "next build" } }), "pnpm-lock.yaml": "" })
    const { fn, calls } = spy({ exitCode: 0 })
    const run = await runBuild({ root, appRoot: "apps/web", spawn: fn, denyReads: { paths: ["/Users/x/.ssh"], prefixes: ["/Users/x/.growth-os"] } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.cmd).toBe("pnpm")
    expect(calls[0]!.args).toEqual(["run", "build"])
    expect(calls[0]!.options).toMatchObject({ network: true, cwd: join(root, "apps/web"), denyReads: ["/Users/x/.ssh"], denyReadPrefixes: ["/Users/x/.growth-os"] })
    expect(calls[0]!.options.env).toMatchObject({ NEXT_TELEMETRY_DISABLED: "1" })
    // writes: the build's output dirs only (review I1 P1-3), never the repo at large, its git dir, husky hooks or
    // the wizard's state (review O6-R1)
    expect(calls[0]!.options.allowWrites).toEqual(buildAllowedWrites(root, join(root, "apps/web")))
    expect(calls[0]!.options.allowWrites).not.toContain(root)
    expect(calls[0]!.options.allowWrites).toEqual(expect.arrayContaining([join(root, "apps/web/.next"), join(root, "apps/web/next-env.d.ts"), join(root, "node_modules/.cache")]))
    expect(calls[0]!.options.denyWrites).toEqual(buildDeniedWrites(root, join(root, "apps/web")))
    expect(calls[0]!.options.denyWrites).toEqual(expect.arrayContaining([join(root, ".git"), join(root, ".husky"), join(root, ".infinite"), join(root, "apps/web/.infinite")]))
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
  const stylish = JSON.parse(readFileSync(new URL("../../test/fixtures/lint-diagnostics/eslint-stylish.json", import.meta.url), "utf8")) as Array<{ version: string; base: string; warning: string; duplicate: string; fatal: string; fatalShifted: string }>

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
    expect(red.failureSignature).toEqual(["build: exit_code:2"])
    expect(gradeBuild("build", red, green, ctx).state).toBe("problem")
    expect(gradeBuild("build", red, null, ctx).state).toBe("problem")
    expect(gradeBuild("build", green, null, ctx).state).toBe("pass")
  })
})

describe("the whole failure set is compared (review O6-R25)", () => {
  const many = (count: number, extra: string[] = []) => [...Array.from({ length: count }, (_, i) => `error TS2322: problem number ${String(i).padStart(4, "0")}`), ...extra].join("\n")

  it("both red with no recognisable error line (only an exit code) is undetermined, never 'fails exactly as before'", () => {
    const opaque = { ok: false, failureSignature: ["exit_code:1"], durationMs: 1 }
    expect(gradeBuild("build", opaque, opaque, ctx)).toMatchObject({ state: "undetermined", reason: expect.stringContaining("test_error") })
    const readable = { ok: false, failureSignature: ["Type error: x"], durationMs: 1 }
    expect(gradeBuild("build", opaque, readable, ctx).state).toBe("undetermined")
    // negative: a readable failure that matches the baseline is still a pass, and a green baseline makes it new
    expect(gradeBuild("build", readable, readable, ctx).state).toBe("pass")
    expect(gradeBuild("build", opaque, { ok: true, failureSignature: [], durationMs: 1 }, ctx).state).toBe("problem")
  })
})


describe.runIf(process.platform === "darwin")("darwin: a real sandboxed build may write its outputs but never a git hook", () => {
  it("npm run build writes dist/ and is refused .git/hooks/pre-commit", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "build-real-")))
    mkdirSync(join(root, ".git", "hooks"), { recursive: true })
    const script =
      "node -e \"const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/out.txt','ok');const w=(f,k)=>{try{fs.writeFileSync(f,'x');console.log(k+'=written')}catch(e){console.log(k+'='+e.code)}};w('.git/hooks/pre-commit','HOOK');w('.lintstagedrc','LINTSTAGED');w('app.js','SOURCE');w('next-env.d.ts','NEXTENV')\""
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", scripts: { build: script } }))
    writeFileSync(join(root, "app.js"), "export default 1\n")
    const run = await runBuild({ root, appRoot: ".", packageManager: "npm", timeoutMs: 60_000 })
    expect(run.sandboxed).toBe(true)
    expect(run.ok).toBe(true)
    expect(readFileSync(join(root, "dist", "out.txt"), "utf8")).toBe("ok")
    expect(run.outputTail.join("\n")).toContain("HOOK=EPERM")
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false)
    // Review I1 P1-3: a hook config or a source file is not build output, so the build cannot write it.
    expect(run.outputTail.join("\n")).toContain("LINTSTAGED=EPERM")
    expect(run.outputTail.join("\n")).toContain("SOURCE=EPERM")
    expect(readFileSync(join(root, "app.js"), "utf8")).toBe("export default 1\n")
    expect(run.outputTail.join("\n")).toContain("NEXTENV=written")
  })
})
