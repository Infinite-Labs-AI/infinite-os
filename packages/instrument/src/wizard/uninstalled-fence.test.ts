import { describe, expect, it } from "vitest"
import { GITIGNORE_FENCE_BLOCK } from "../harness/outputs.js"
import { restoreUninstalledFence } from "./uninstalled-fence.js"
import type { WizardDeps } from "./contracts/deps.js"

describe("unsupported install fence rollback", () => {
  it.each([null, "node_modules/\r\n"])("restores the exact original %j", async original => {
    let current: string | null = `${original ?? ""}${original && !original.endsWith("\n") ? "\n" : ""}${GITIGNORE_FENCE_BLOCK}\n`
    const deps = { git: { statusEntries() {}, unstage() {}, stagedDiff() {}, showFile: async () => original }, fs: { readText: async () => current, writeTextAtomic: async (_path: string, text: string) => { current = text }, removeFile: async () => { current = null; return true } } } as unknown as WizardDeps
    expect(await restoreUninstalledFence("/site", deps)).toBe(true)
    expect(current).toBe(original)
  })
  it("preserves later owner edits", async () => {
    const current = `node_modules/\n${GITIGNORE_FENCE_BLOCK}\nowner-file\n`
    const deps = { git: { statusEntries() {}, unstage() {}, stagedDiff() {}, showFile: async () => "node_modules/\n" }, fs: { readText: async () => current, writeTextAtomic: async () => { throw new Error("must not write") } } } as unknown as WizardDeps
    expect(await restoreUninstalledFence("/site", deps)).toBe(false)
  })
})
