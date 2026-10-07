import { expect, it } from "vitest"
import { wizardOwnership } from "../review/ownership.js"
import { checkClickIdCapture } from "../setup-checks/click-id-capture.js"
import { buildAllow, checkEdit, globalDenyReason, unionAllow } from "./allow.js"

const appRoot = "apps/store"
const policy = `${appRoot}/app/(public)/[market]/privacy/page.tsx`

it("threads the app root through all allowlist filters", () => {
  const allow = { files: [policy], create: [] }
  expect(globalDenyReason(policy, [], appRoot)).toEqual({ kind: "policy_file" })
  expect(buildAllow([policy], [], [], appRoot).files).toEqual([])
  expect(unionAllow([allow], [], appRoot).files).toEqual([])
  expect(checkEdit(allow, policy, "modify", [], appRoot)).toMatchObject({ ok: false, reason: "denied", deny: { kind: "policy_file" } })
})

it("recognizes a recorded policy edit relative to the app root during review", async () => {
  const receipt = JSON.stringify({ edits: [{ by: "agent", file: policy, beforeHash: "existing", textEdits: [] }] })
  const ownership = await wizardOwnership({ fs: { readText: async path => path.endsWith(".infinite/install.json") ? receipt : "page text" } } as Parameters<typeof wizardOwnership>[0], "/fixture", async () => true, appRoot)
  expect(ownership.writtenByRun?.(policy, 1)).toBe(true)
})

it("excludes owner-only static policy pages from a managed capture check under the app root", () => {
  const index = `${appRoot}/index.html`
  const privacy = `${appRoot}/de/privacy.html`
  const page = "<html><head></head><body>Page</body></html>"
  expect(checkClickIdCapture({ files: new Map([[index, page], [privacy, page]]), managedCaptureEntries: [index], appRoot }).state).toBe("ok")
})
