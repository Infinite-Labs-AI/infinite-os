import { expect, it } from "vitest"
import { buildPlanModel, resolvePlanAnswers } from "./plan-model.js"
import { fakeBefore, fakeKeys, fakeProductionDeniedConflict } from "../../test/wizard/o7-fakes.js"
const base = { keys: fakeKeys(), before: fakeBefore(), candidates: [], agent: { worker: "claude_code" as const, whoPays: { payer: "plan" as const, label: "plan" } }, consentFlag: "not_required" as const, productionDeniedConflict: fakeProductionDeniedConflict }
it.each([ true])("scopes sensitive-page work before offering the plan or budget (detector candidate %s)", (hasCandidate) => {
  const file = "src/tracking.ts"
  const plan = buildPlanModel({ ...base, candidates: hasCandidate ? [{ id: "posthog_improve:sensitive_pages", jobId: "posthog_improve", n: 3, title: "Sensitive pages", owner: "agent", state: "pending", checks: [], allow: { files: [file], create: [] }, trigger: { finding: "Protect sensitive pages", evidence: [{ file, line: 2 }] } }] : [], scan: { framework: "next-app-router", managedProviders: [], adopted: [{ provider: "posthog", via: "snippet", file, line: 2, key: "phc_fake" }], improve: [{ id: "sensitive", owner: "agent", kind: "sensitive_pages", provider: "posthog", target: "sensitive_pages", text: "Protect sensitive pages", evidence: { file, line: 2 } }], serverLane: null, npm: null, sensitivePaths: ["/account"], sources: { [file]: "function boot() {\nposthog.init('phc_fake', {});\nposthog.opt_out_capturing();\n}\n" } } } as Parameters<typeof buildPlanModel>[0])
  const item = [...plan.scopedCandidates ?? [], ...plan.seeds].find(item => item.id === "posthog_improve:sensitive_pages")!
  expect(item.state).toBe("left_for_you")
  expect(plan.lines.find(line => line.id === "sensitive")?.requires).toBe("user_action")
  expect(plan.lines.filter(line => line.requires === "approval").some(line => line.jobIds?.includes(item.id))).toBe(false)
  expect(plan.lines.some(line => line.id === "agent_budget")).toBe(false)
})

it("shows an unwritable entry first and does not offer unused provider installs", () => {
  const plan = buildPlanModel({ ...base, scan: { framework: "next-app-router", managedProviders: [], adopted: [], improve: [], serverLane: null, npm: null, sensitivePaths: [], sources: {}, ownerWiring: { canWire: false, entrypoints: ["app/layout.tsx"], writableEntrypoints: [], requirements: [{ path: "app/layout.tsx", reason: "owner consent", snippet: '<InfiniteAnalyticsClient />', ownerBoundary: { kind: "frozen_unit", file: "app/layout.tsx", line: 1 } }] } } })
  expect(plan.lines[0]!.text).toContain("NOT installed")
  expect(plan.lines[0]!.text).toContain("<InfiniteAnalyticsClient />")
  expect(plan.installTools).toEqual([])
  expect(plan.lines.some(line => line.id === "install_provider:infinite")).toBe(false)
})

it.each([[true, false, true, true], [false, false, true, true],])("plans managed capture from the entry before jobs (entry writable %s, formerly frozen %s, sources available %s, needs entry edit %s)", (canWire, formerlyFrozen, withSources, needsEntryEdit) => {
  const entry = "pages/_app.tsx"
  const pixel = "src/pixel.ts"
  const candidates = formerlyFrozen ? [{ id: "meta_improve:capture", jobId: "meta_improve" as const, n: 5, title: "Capture", owner: "agent" as const, state: "left_for_you" as const, checks: [], allow: { files: [pixel], create: [] }, trigger: { finding: "Missing capture", evidence: [{ file: pixel, line: 1 }] }, ownerBoundary: { kind: "frozen_unit" as const, file: pixel, line: 1 } }] : []
  const plan = buildPlanModel({ ...base, candidates, scan: { framework: "next-pages-router", managedProviders: [], adopted: [{ provider: "meta", via: "snippet", file: pixel, line: 1, key: "123456789" }], improve: [{ id: "capture_beside_adopted_pixel:meta:capture", kind: "capture_beside_adopted_pixel", owner: "code", provider: "meta", target: "capture", text: "Save click ids", evidence: { file: pixel, line: 1 } }], serverLane: null, npm: null, sensitivePaths: [], sources: withSources ? { [pixel]: "fbq('consent', 'revoke');", [entry]: needsEntryEdit ? "export default function App() { return null }" : "fbq('consent', 'revoke');" } : undefined, managedCapture: { canWire, module: "lib/infinite-meta-click-id.js", entrypoints: canWire ? [entry] : [], editEntrypoints: canWire && needsEntryEdit ? [entry] : [], pixelFiles: [pixel], strategy: "first_import", requirements: canWire ? [] : [{ path: entry, reason: "Entry handles owner consent", snippet: 'import "../lib/infinite-meta-click-id.js"', ownerBoundary: { kind: "frozen_unit", file: entry, line: 1 } }] } } })
  const capture = [...plan.scopedCandidates ?? [], ...plan.seeds].find(item => item.id === "meta_improve:capture")!
  expect(capture.owner).toBe("code")
  expect(capture.state).toBe(canWire ? "pending" : "left_for_you")
  expect(capture.allow.files).not.toContain(pixel)
  expect(plan.lines.some(line => line.id === "agent_budget")).toBe(false)
  // Legacy answer files may approve every old line, including one now left to the owner.
  const captureLine = plan.lines.find(line => line.kind === "capture_beside_adopted_pixel")!
  const answers = resolvePlanAnswers(plan, { approved: plan.lines.map(line => line.id), declined: [], edits: { [captureLine.id]: "yes" } }, { consentFlag: "not_required" })
  expect(answers.approvals.approved.includes(captureLine.id)).toBe(canWire)
  expect(answers.lines.find(line => line.id === captureLine.id)?.approved).toBe(canWire ? true : null)
  expect(answers.approvals.edits).not.toHaveProperty(captureLine.id)
  if (canWire) {
    expect(capture.allow.files).toEqual(needsEntryEdit ? [entry] : [])
    expect(capture.checks.map(check => `${check.tier}:${check.id}`)).toEqual(["S:click_id_capture", "T0:fbc_capture", "PV:meta_seen_leaving"])
    expect(plan.lines.find(line => line.kind === "capture_beside_adopted_pixel")?.requires).toBe("info")
  } else {
    expect(capture.ownerBoundary?.file).toBe(entry)
    expect(capture.ownerBoundary?.wiring).toContain("infinite-meta-click-id")
    expect(capture.note).toContain("For you: load the ad-click capture from your app entry, so the landing ad-click id is saved.")
    expect(capture.note).toContain("Entry handles owner consent")
    expect(plan.lines.find(line => line.kind === "capture_beside_adopted_pixel")?.requires).toBe("user_action")
    expect(plan.lines.filter(line => line.text.includes('import "../lib/infinite-meta-click-id.js"'))).toHaveLength(1)
  }
})

it("drops stale and malicious approvals for owner-only and informational lines", () => {
  const plan = buildPlanModel({ ...base, scan: { framework: "next-app-router", managedProviders: [], adopted: [{ provider: "meta", via: "snippet", file: "src/pixel.ts", line: 1, key: "123456789" }], improve: [], serverLane: null, npm: null, sensitivePaths: [] } })
  const informational = plan.lines.filter(line => line.kind === "meta_goal" || line.kind === "checkin" || line.requires === "user_action")
  expect(informational.length).toBeGreaterThan(2)
  const staleIds = [...informational.map(line => line.id), "unknown:old_action"]
  const answer = resolvePlanAnswers(plan, { approved: staleIds, declined: ["install_provider:infinite"], edits: Object.fromEntries(staleIds.map(id => [id, "yes"])) }, { consentFlag: "not_required" })
  for (const id of staleIds) {
    expect(answer.approvals.approved).not.toContain(id)
    expect(answer.approvals.edits).not.toHaveProperty(id)
  }
  // Explicit exclusions stay binding even when repository work normally continues.
  expect(answer.approvals.approved).not.toContain("install_provider:infinite")
  expect(answer.approvals.declined).toContain("install_provider:infinite")
  expect(answer.approvals.approved).not.toContain("account_settings:ga4")
  const explicit = resolvePlanAnswers(plan, { approved: ["account_settings:ga4"], declined: [], edits: {} }, { consentFlag: "not_required" })
  expect(explicit.approvals.approved).toContain("account_settings:ga4")
})

