import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { cleanupSites, makeSite, read } from "../../test/wizard/o7-fakes.js"
import { packageInstallCommand, type CommandSpawner } from "../package-manager.js"
import { applyTextEdits } from "../server-lane/text-edits.js"

import { sha256Tagged } from "./edits.js"
import { findLockfile, runNpmJob } from "./npm.js"

afterEach(cleanupSites)

const PACKAGE_JSON = `{\n  "name": "acme",\n  "dependencies": {\n    "next": "15.0.0"\n  }\n}\n`

/** A fake package manager: runs in the given cwd, writes what a real one would, then exits. */
function fakeInstaller(exitCode: number, effect: (cwd: string) => void): CommandSpawner & { calls: Array<{ command: string; args: readonly string[]; cwd: string }> } {
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = []
  const spawn = (async (command: string, args: readonly string[], options: { cwd: string }) => {
    calls.push({ command, args, cwd: options.cwd })
    effect(options.cwd)
    return { exitCode, outputTail: exitCode === 0 ? "" : "ERR! network", timedOut: false }
  }) as unknown as CommandSpawner & { calls: typeof calls }
  spawn.calls = calls
  return spawn
}

const addDependency = (cwd: string, lockfile: string) => {
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"))
  pkg.dependencies["@vercel/functions"] = "^2.0.0"
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`)
  writeFileSync(join(cwd, lockfile), "lockfile v2 with @vercel/functions\n")
}

describe("packageInstallCommand: the exact argv per package manager (no shell)", () => {
  it.each([
    ["npm", ["install", "@vercel/functions"]],
    ["pnpm", ["add", "@vercel/functions"]],
  ] as const)("%s", (manager, args) => {
    expect(packageInstallCommand(manager, ["@vercel/functions"])).toEqual({ command: manager, args })
  })

  it("NEGATIVE: never turns a package name into a flag or a shell fragment", () => {
    for (const bad of ["--ignore-scripts", "-g", "foo;rm -rf /", "$(id)", "foo bar", ""]) {
      expect(() => packageInstallCommand("npm", [bad])).toThrow(/Refusing to install/)
    }
    expect(() => packageInstallCommand("npm", [])).toThrow()
  })
})

describe("runNpmJob (code job C1, decision 5)", () => {
  it("runs the repo's package manager in the app root and records package.json + the lockfile as wizard edits", async () => {
    const root = makeSite({ "package.json": PACKAGE_JSON, "pnpm-lock.yaml": "lockfile v1\n" })
    const spawn = fakeInstaller(0, (cwd) => addDependency(cwd, "pnpm-lock.yaml"))
    const result = await runNpmJob({ root, appRoot: ".", packages: ["@vercel/functions"], runId: "run-1", planLineId: "npm_install", spawn })
    expect(spawn.calls).toEqual([{ command: "pnpm", args: ["add", "@vercel/functions"], cwd: root }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.edits.map((edit) => edit.file)).toEqual(["package.json", "pnpm-lock.yaml"])
    for (const edit of result.edits) {
      expect(edit.by).toBe("wizard")
      expect(edit.jobId).toBe("npm_install")
      expect(edit.planLineId).toBe("npm_install")
      expect(edit.afterHash).toBe(sha256Tagged(read(root, edit.file)))
    }
    expect(applyTextEdits(PACKAGE_JSON, result.edits[0]!.textEdits)).toBe(read(root, "package.json"))
  })

  it("NEGATIVE: a failed install restores package.json and the lockfile byte-identically", async () => {
    const lock = Buffer.from([0x6c, 0x6f, 0x63, 0x6b, 0x0a, 0xe2, 0x9c, 0x93, 0x0a]) // includes multi-byte utf8
    const root = makeSite({ "package.json": PACKAGE_JSON })
    writeFileSync(join(root, "package-lock.json"), lock)
    const spawn = fakeInstaller(1, (cwd) => addDependency(cwd, "package-lock.json"))
    const result = await runNpmJob({ root, appRoot: ".", packages: ["@vercel/functions"], runId: "run-1", planLineId: "npm_install", spawn })
    expect(result).toMatchObject({ ok: false, restored: true, edits: [] })
    expect(read(root, "package.json")).toBe(PACKAGE_JSON)
    expect(readFileSync(join(root, "package-lock.json")).equals(lock)).toBe(true)
  })

  it("NEGATIVE: no lockfile (the manager is unknown), two kinds, or bun.lockb → nothing runs", async () => {
    const spawn = fakeInstaller(0, () => {
      throw new Error("must not run")
    })
    const none = makeSite({ "package.json": PACKAGE_JSON })
    expect(await runNpmJob({ root: none, appRoot: ".", packages: ["@vercel/functions"], runId: "r", planLineId: null, spawn })).toMatchObject({ ok: false, reason: expect.stringMatching(/^no_lockfile/) })
    const two = makeSite({ "package.json": PACKAGE_JSON, "yarn.lock": "", "package-lock.json": "{}" })
    expect(findLockfile(two, ".")).toMatchObject({ ok: false, reason: "multiple_lockfiles" })
    const binary = makeSite({ "package.json": PACKAGE_JSON, "bun.lockb": "\u0000" })
    expect(findLockfile(binary, ".")).toMatchObject({ ok: false, reason: "binary_lockfile" })
    expect(spawn.calls).toHaveLength(0)
  })
})
