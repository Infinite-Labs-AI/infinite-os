import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { inspectSourceLayout } from "./source-layout.js"
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(config: unknown) {
  const root = mkdtempSync(join(tmpdir(), "tag-layout-"))
  roots.push(root)
  writeFileSync(join(root, "vercel.json"), JSON.stringify(config))
  return root
}
it("distinguishes build output from editable source without executing the build", () => {
  const root = fixture({ buildCommand: "echo SECRET_DO_NOT_PRINT", outputDirectory: "dist" })
  mkdirSync(join(root, "dist"))
  const source = inspectSourceLayout(root, ".", "0.9.1")
  expect(source.generatedTarget).toBe(false)
  expect(source.notes.join(" ")).toContain("source")
  expect(source.notes.join(" ")).toContain("dist")
  expect(source.notes.join(" ")).not.toContain("SECRET_DO_NOT_PRINT")
  expect(inspectSourceLayout(root, "dist/get-started", "0.9.1").generatedTarget).toBe(true)
})
it("does not treat a plain static publish directory as generated without a build", () => {
  const root = fixture({ outputDirectory: "public" })
  expect(inspectSourceLayout(root, "public", "0.9.1").generatedTarget).toBe(false)
})
it("ignores unsafe output paths and reports an older exact project pin", () => {
  const root = fixture({ buildCommand: "build", outputDirectory: "../outside" })
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ devDependencies: { "infinite-tag": "0.6.0" } })
  )
  const result = inspectSourceLayout(root, ".", "0.9.1")
  expect(result.outputDirectory).toBeUndefined()
  expect(result.notes.join(" ")).toContain("0.6.0")
  expect(result.notes.join(" ")).toContain("does not upgrade")
})
it("never recommends downgrading a newer project pin", () => {
  const root = fixture({})
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { "infinite-tag": "1.0.0" } })
  )
  expect(inspectSourceLayout(root, ".", "0.9.1").notes).toEqual([])
})
