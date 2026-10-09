import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { cleanup, item, makeFenceFixture, tempDir, write } from "../../test/wizard/repo.js"
import { Fence } from "./fence.js"
const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))
const file = "src/tracking.ts"
const before = "function boot() {\n  gtag('consent', 'default', {\n    analytics_storage: 'denied'\n  });\n}\n"

it.each([
  ["indentation", before.replace("  gtag", "    gtag")],
  ["deletion", before.replace(/  gtag[\s\S]*?\);\n/, "")],
  ["uncalled function", before.replace("  gtag", "  function neverCalled() { gtag").replace("  });", "  }); }")],
  ["wrapper", before.replace("  gtag", "  if (hostAllowed) { gtag").replace("  });", "  }); }")],
])("strictly reverts %s with no semantic/formatting exemption", async (_name, after) => {
  const { root } = makeFenceFixture()
  const home = tempDir("consent-boundary-")
  dirs.push(root, home)
  write(root, file, before)
  const fence = await Fence.begin({ root, snapshotDir: join(home, "fence"), runId: "boundary", turn: 1, items: [item("meta_improve:capture", [file])] })
  write(root, file, after)
  fence.recordEditActivity("meta_improve:capture", file)
  expect((await fence.claimConsentProblems("meta_improve:capture")).join(" ")).toContain("your change there was put back")
  expect((await fence.end()).blocked).toEqual([expect.objectContaining({ itemId: "meta_improve:capture", reason: "consent_touched" })])
  expect(readFileSync(join(root, file), "utf8")).toBe(before)
})

it("warns every claimant with no progress events, reverts consent, and keeps a separate harmless hunk", async () => {
  const { root } = makeFenceFixture()
  const home = tempDir("consent-shared-")
  dirs.push(root, home)
  const original = `${before}\n\n\n\n\n\nexport const version = 1;\n`
  write(root, file, original)
  const ids = ["preview_guard:meta", "meta_improve:capture"]
  const fence = await Fence.begin({ root, snapshotDir: join(home, "fence"), runId: "boundary", turn: 1, items: ids.map(id => item(id, [file])) })
  write(root, file, original.replace("  gtag", "    gtag").replace("version = 1", "version = 2"))
  for (const id of ids) expect((await fence.claimConsentProblems(id)).join(" ")).toContain("your change there was put back")
  expect((await fence.end()).blocked).toEqual([])
  expect(readFileSync(join(root, file), "utf8")).toBe(original.replace("version = 1", "version = 2"))
})

it("reverts moving consent below an existing config call", async () => {
  const { root } = makeFenceFixture()
  const home = tempDir("consent-reorder-")
  dirs.push(root, home)
  const consent = "gtag('consent', 'default', { analytics_storage: 'denied' });\n"
  const config = "gtag('config', 'G-FAKE');\n"
  write(root, file, consent + config)
  const fence = await Fence.begin({ root, snapshotDir: join(home, "fence"), runId: "boundary", turn: 1, items: [item("meta_improve:capture", [file])] })
  write(root, file, config + consent)
  fence.recordEditActivity("meta_improve:capture", file)
  expect((await fence.end()).blocked).toContainEqual(expect.objectContaining({ reason: "consent_touched" }))
  expect(readFileSync(join(root, file), "utf8")).toBe(consent + config)
})
