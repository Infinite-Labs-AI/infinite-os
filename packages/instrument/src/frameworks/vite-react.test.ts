import { describe, expect, it } from "vitest"

// Access the internal helpers via the exported adapter's plan logic indirectly,
// but for unit-testing the scanner we inline-test via upsertMainEntrypoint
// behaviour (which is the only consumer of findImportSectionEnd /
// consumeImportStatement). We do this by importing the adapter and driving it
// through planInstallation-style inputs, avoiding the need to export internals.

// The functions under test are not exported, so we test them through the
// public surface: upsertMainEntrypoint is exercised via the adapter's apply()
// path, but findImportSectionEnd / consumeImportStatement are more directly
// exercised by calling them inline. Since they are not exported, we test their
// effects through plan() (which calls findImportSectionEnd and returns a blocker
// when it returns null) and through a small inline reimport trick.
//
// Rather than re-export internals, we test the observable outcomes:
//   FIX 1 — a file with `importantSetup()` does NOT get a "no import block" blocker
//            and the wiring is injected BEFORE the non-import line.
//   FIX 2 — a file with a stray `{` inside a line comment is accepted and wired.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach } from "vitest"
import { cpSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { planInstallation } from "../plan.js"
import { inspectWorkspace } from "../inspect.js"
import { applyInstallation } from "../apply.js"

const tempRoots: string[] = []
const fixtureRoot = dirname(fileURLToPath(import.meta.url))

function copyFixture(name: string): string {
  const source = join(fixtureRoot, "../../test/fixtures", name)
  const targetRoot = mkdtempSync(join(tmpdir(), `instrument-vite-react-test-${name}-`))
  const target = join(targetRoot, name)
  tempRoots.push(targetRoot)
  cpSync(source, target, { recursive: true })
  return target
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

const REACT_DOM_BOOT = 'ReactDOM.createRoot(document.getElementById("root")!).render(<App />)'
const BASE_ARTIFACTS = { ga4: { measurementId: "G-TEST123" } }

describe("vite-react import scanner — FIX 1: word-boundary check", () => {
  it("does not consume importantSetup() as an import statement", async () => {
    const root = copyFixture("vite-react-basic")
    // Write a main.tsx where an identifier starting with "import" (importantSetup)
    // appears immediately after the real import block.
    writeFileSync(
      join(root, "src/main.tsx"),
      [
        'import "./styles.css"',
        "importantSetup()",
        REACT_DOM_BOOT,
        ""
      ].join("\n")
    )

    const inspect = await inspectWorkspace(root)
    const plan = await planInstallation({ root, inspect, artifacts: BASE_ARTIFACTS })

    // The plan should succeed (no blocker about import block)
    expect(plan.blockers).not.toContain(
      "Vite React apply requires a simple import block at the top of src/main.*."
    )
    expect(plan.applyMode).toBe("supported")

    // Apply and verify the injected wiring lands before importantSetup(), not after
    applyInstallation({ root, workspaceId: "ws-test", plan, allowDirty: true })

    const { readFileSync } = await import("node:fs")
    const result = readFileSync(join(root, "src/main.tsx"), "utf8")

    const importLinePos = result.indexOf('import { installInfiniteInstrumentation }')
    const importantSetupPos = result.indexOf("importantSetup()")
    expect(importLinePos).toBeGreaterThanOrEqual(0)
    expect(importantSetupPos).toBeGreaterThan(importLinePos)
  })
})

describe("vite-react import scanner — FIX 2: comment/string delimiter skipping", () => {
  it("accepts a main.tsx with a stray { inside a line comment and is not forced to plan-only", async () => {
    const root = copyFixture("vite-react-basic")
    // A line comment containing an unbalanced `{` must not confuse the depth counter.
    writeFileSync(
      join(root, "src/main.tsx"),
      [
        'import x from "./x" // a comment with a stray {',
        'import y from "./y"',
        REACT_DOM_BOOT,
        ""
      ].join("\n")
    )

    const inspect = await inspectWorkspace(root)
    const plan = await planInstallation({ root, inspect, artifacts: BASE_ARTIFACTS })

    // Must NOT be refused to plan-only due to a null findImportSectionEnd
    expect(plan.blockers).not.toContain(
      "Vite React apply requires a simple import block at the top of src/main.*."
    )
    expect(plan.applyMode).toBe("supported")

    // Apply must succeed and inject wiring
    expect(() =>
      applyInstallation({ root, workspaceId: "ws-test", plan, allowDirty: true })
    ).not.toThrow()

    const { readFileSync } = await import("node:fs")
    const result = readFileSync(join(root, "src/main.tsx"), "utf8")
    expect(result).toContain("installInfiniteInstrumentation()")
  })

  it("accepts a main.tsx with a stray { inside an import path string", async () => {
    const root = copyFixture("vite-react-basic")
    // An import path string containing `{` must not throw off the depth counter.
    writeFileSync(
      join(root, "src/main.tsx"),
      [
        'import x from "./path{with}braces"',
        'import y from "./y"',
        REACT_DOM_BOOT,
        ""
      ].join("\n")
    )

    const inspect = await inspectWorkspace(root)
    const plan = await planInstallation({ root, inspect, artifacts: BASE_ARTIFACTS })

    expect(plan.applyMode).toBe("supported")
    expect(plan.blockers).not.toContain(
      "Vite React apply requires a simple import block at the top of src/main.*."
    )
  })
})
