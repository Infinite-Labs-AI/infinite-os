import { describe, expect, it } from "vitest"
import { beforeFacts, scanResult } from "../../../test/wizard/o8/fixtures.js"
import { snapshotFromFiles } from "../repo-files.js"
import { seedCandidatesFrom } from "../registry.js"
import { jobScanFrom } from "./index.js"
import { detectConversionSuccessPaths } from "./outcomes.js"

const FILE = "components/WaitlistForm.tsx"
const form = (condition: string) => `export default function WaitlistForm() {
  async function submit() {
    const res = await fetch('/api/enrol', { method: 'POST' });
    const data = await res.json();
    if (${condition}) {
      recordLead();
    }
  }
  return <form onSubmit={submit}><button>Join</button></form>;
}`

describe("browser outcome success branches", () => {
  it.each(["res.ok && data?.success",])("recognizes the explicit positive branch %s", condition => {
    const snapshot = snapshotFromFiles({ [FILE]: form(condition) })
    expect(detectConversionSuccessPaths(snapshot)).toEqual([{ file: FILE, line: 5, detail: "lead success", conversionType: "lead" }])
    const item = seedCandidatesFrom(jobScanFrom(scanResult(), snapshot), beforeFacts()).find(candidate => candidate.id === "conversions_to_tools:lead")
    expect(item).toMatchObject({ state: "pending", allow: { files: [FILE] }, trigger: { evidence: [{ file: FILE, line: 5 }] } })
    expect(item?.blockedReason).toBeUndefined()
  })

  it.each(["res.ok || data.success", "res.ok && !data.success", "!res.ok && data.success",])("does not turn a failure or ambiguous branch into success: %s", condition => {
    expect(detectConversionSuccessPaths(snapshotFromFiles({ [FILE]: form(condition) }))).toEqual([])
  })

  it("recognizes a Stripe-style /success page with existing purchase analytics as the purchase success surface", () => {
    const file = "pages/success.tsx"
    const snapshot = snapshotFromFiles({
      [file]: `export default function Success() {
  const sessionId = new URLSearchParams(location.search).get("session_id")
  if (sessionId) {
    gtag("event", "purchase", { transaction_id: sessionId })
  }
  return <p>Thanks</p>
}`
    })
    expect(detectConversionSuccessPaths(snapshot)).toEqual([{ file, line: 4, detail: "purchase success", conversionType: "purchase" }])
  })
})
