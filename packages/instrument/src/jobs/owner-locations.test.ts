import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { candidate } from "../../test/wizard/o7-fakes.js"
import { buildMetaClickIdCaptureTypescript } from "../providers/meta-browser/click-id.js"
import { sourceUnits } from "./consent-units.js"
import { reanchorOwnerLocations } from "./owner-locations.js"

it("relocates owner instructions to the same unchanged unit after a real capture is prepended", async () => {
  const root = await mkdtemp(join(tmpdir(), "infinite-owner-location-"))
  try {
    const before = "export function boot() {\n  fbq('init','123');\n  fbq?.('consent','revoke');\n}\n"
    const unit = sourceUnits(before).units[0]!
    const job = candidate("preview_guard", "meta", { state: "left_for_you", checks: [],
      note: "Old location: tracking.ts:2", trigger: { finding: "Place the guard at tracking.ts:2.\n```js\nif (location.hostname === 'example.test') {}\n```", evidence: [{ file: "tracking.ts", line: 2 }] },
      ownerBoundary: { kind: "frozen_unit", file: "tracking.ts", line: 2, unitHash: unit.hash, unitOrdinal: unit.ordinal, lineOffset: 1, guard: "if (location.hostname === 'example.test') {}" } })
    const capture = buildMetaClickIdCaptureTypescript({ gate: { kind: "infinite-consent", mode: "required" } })
    const after = `${capture}\n${before}`
    await writeFile(join(root, "tracking.ts"), after)
    const [moved] = await reanchorOwnerLocations(root, [job])
    const actualLine = after.split("\n").findIndex(line => line.includes("fbq('init'")) + 1
    expect(actualLine).toBeGreaterThan(2)
    expect(moved?.ownerBoundary?.line).toBe(actualLine)
    expect(moved?.trigger.evidence).toEqual([{ file: "tracking.ts", line: actualLine }])
    expect(moved?.trigger.finding).toContain(`tracking.ts:${actualLine}`)
    expect(moved?.note).toContain(`tracking.ts:${actualLine}`)
    expect(moved?.ownerBoundary?.guard).toBe(job.ownerBoundary?.guard)
  } finally { await rm(root, { recursive: true, force: true }) }
})
