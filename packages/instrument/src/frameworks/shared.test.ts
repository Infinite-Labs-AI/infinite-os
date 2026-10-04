import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { writeFileIfChanged } from "./shared.js"

const tempRoots: string[] = []

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe("writeFileIfChanged write confinement", () => {
  it("refuses a relative path that escapes the root and writes nothing", () => {
    const root = makeTempRoot("instrument-shared-escape-")
    const sibling = join(root, "..", "instrument-shared-escape-victim.txt")

    expect(() => writeFileIfChanged(root, "../instrument-shared-escape-victim.txt", "owned")).toThrow(
      /outside the workspace root/
    )
    expect(existsSync(sibling)).toBe(false)
  })

  it("refuses to write through a symlinked directory that points outside the root", () => {
    const root = makeTempRoot("instrument-shared-symlink-")
    const outside = makeTempRoot("instrument-shared-symlink-target-")
    symlinkSync(outside, join(root, "lib"))

    expect(() => writeFileIfChanged(root, "lib/payload.txt", "owned")).toThrow(
      /outside the workspace root/
    )
    expect(existsSync(join(outside, "payload.txt"))).toBe(false)
  })

  it("still writes normal files inside the root", () => {
    const root = makeTempRoot("instrument-shared-ok-")

    expect(writeFileIfChanged(root, "nested/dir/file.txt", "hello")).toBe(true)
    expect(readFileSync(join(root, "nested/dir/file.txt"), "utf8")).toBe("hello")
    expect(writeFileIfChanged(root, "nested/dir/file.txt", "hello")).toBe(false)
  })
})
