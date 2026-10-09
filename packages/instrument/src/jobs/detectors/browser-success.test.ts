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

  // A mailing-list signup page whose handler leaves on failure (`if (!res.ok) { …; return }`): the success is the code
  // AFTER the guard. Its path names the lead (`/mailing-list`, as the server route's detector already reads it).
  const signupPage = (guard: string) => `export default function MailingListPage() {
  const onSubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/mailing-list", { method: "POST", body: JSON.stringify({ email }) });
      ${guard}
      generateLead();
      setStatus("done");
    } catch {
      setStatus("error");
    }
  };
  return <form onSubmit={onSubmit}><button>Join</button></form>;
}`

  it.each([
    'if (!res.ok) {\n        setError("Something went wrong.");\n        return;\n      }',
    "if (!res.ok) return;",
    'if (!res.ok) throw new Error("failed");'
  ])("recognizes the code after a failure guard that leaves as the lead's success: %s", guard => {
    const file = "pages/mailing-list.tsx"
    expect(detectConversionSuccessPaths(snapshotFromFiles({ [file]: signupPage(guard) }))).toEqual([{ file, line: 6, detail: "lead success", conversionType: "lead" }])
  })

  it("a failure guard that does not leave is no success point", () => {
    const file = "pages/mailing-list.tsx"
    expect(detectConversionSuccessPaths(snapshotFromFiles({ [file]: signupPage('if (!res.ok) {\n        setError("Something went wrong.");\n      }') }))).toEqual([])
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
