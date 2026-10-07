import { expect, it } from "vitest"
import { buildPlanModel, resolvePlanAnswers, seedItemsAfterApprovals } from "./plan-model.js"
import { fakeBefore, fakeKeys, fakeProductionDeniedConflict } from "../../test/wizard/o7-fakes.js"
const base = { keys: fakeKeys(), before: fakeBefore(), candidates: [], agent: { worker: "claude_code" as const, whoPays: { payer: "plan" as const, label: "plan" } }, consentFlag: "not_required" as const, productionDeniedConflict: fakeProductionDeniedConflict }
it("scopes improvement-generated jobs before offering the plan or counting its budget", () => {
  const file = "src/tracking.ts"
  const plan = buildPlanModel({ ...base, scan: { framework: "next-app-router", managedProviders: [], adopted: [{ provider: "posthog", via: "snippet", file, line: 2, key: "phc_fake" }], improve: [{ id: "sensitive", owner: "agent", kind: "sensitive_pages", provider: "posthog", target: "sensitive_pages", text: "Protect sensitive pages", evidence: { file, line: 2 } }], serverLane: null, npm: null, sensitivePaths: ["/account"], sources: { [file]: "function boot() {\nposthog.init('phc_fake', {});\nposthog.opt_out_capturing();\n}\n" } } } as Parameters<typeof buildPlanModel>[0])
  const item = plan.seeds.find(item => item.id === "posthog_improve:sensitive_pages")!
  expect(item.state).toBe("left_for_you")
  expect(plan.lines.filter(line => line.requires === "approval").some(line => line.jobIds?.includes(item.id))).toBe(false)
  expect(plan.lines.some(line => line.id === "agent_budget")).toBe(false)
})
it("shows repository work under one continue while account and package actions stay explicit", () => {
  const plan = buildPlanModel({ ...base, scan: { framework: "next-app-router", managedProviders: [], adopted: [], improve: [], serverLane: { targetLabel: "server", installPackages: ["fixture-pkg"] }, npm: { commandLine: "npm install fixture-pkg" }, sensitivePaths: [], sources: {} } } as Parameters<typeof buildPlanModel>[0])
  expect(plan.lines.find(line => line.id === "install_provider:infinite")?.requires).toBe("info")
  expect(plan.lines.find(line => line.kind === "npm_install")?.requires).toBe("approval")
  const answer = resolvePlanAnswers(plan, { approved: [], declined: [], edits: {} }, { consentFlag: "not_required" })
  expect(answer.approvals.approved).toContain("install_provider:infinite")
  expect(answer.approvals.approved).not.toContain("npm_install")
  expect(seedItemsAfterApprovals([], plan.seeds, plan, answer.approvals).every(item => item.state !== "blocked" || item.blockedReason !== "needs_you")).toBe(true)
})

it("shows an unwritable entry first and does not offer unused provider installs", () => {
  const plan = buildPlanModel({ ...base, scan: { framework: "next-app-router", managedProviders: [], adopted: [], improve: [], serverLane: null, npm: null, sensitivePaths: [], sources: {}, ownerWiring: { canWire: false, entrypoints: ["app/layout.tsx"], writableEntrypoints: [], requirements: [{ path: "app/layout.tsx", reason: "owner consent", snippet: '<InfiniteAnalyticsClient />', ownerBoundary: { kind: "frozen_unit", file: "app/layout.tsx", line: 1 } }] } } })
  expect(plan.lines[0]!.text).toContain("NOT installed")
  expect(plan.lines[0]!.text).toContain("<InfiniteAnalyticsClient />")
  expect(plan.installTools).toEqual([])
  expect(plan.lines.some(line => line.id === "install_provider:infinite")).toBe(false)
})

it.each([[true, false], [false, false], [true, true]])("plans managed capture from the entry before jobs (entry writable %s, formerly frozen %s)", (canWire, formerlyFrozen) => {
  const entry = "pages/_app.tsx"
  const pixel = "src/pixel.ts"
  const candidates = formerlyFrozen ? [{ id: "meta_improve:capture", jobId: "meta_improve" as const, n: 5, title: "Capture", owner: "agent" as const, state: "left_for_you" as const, checks: [], allow: { files: [pixel], create: [] }, trigger: { finding: "Missing capture", evidence: [{ file: pixel, line: 1 }] }, ownerBoundary: { kind: "frozen_unit" as const, file: pixel, line: 1 } }] : []
  const plan = buildPlanModel({ ...base, candidates, scan: { framework: "next-pages-router", managedProviders: [], adopted: [{ provider: "meta", via: "snippet", file: pixel, line: 1, key: "123456789" }], improve: [{ id: "capture_beside_adopted_pixel:meta:capture", kind: "capture_beside_adopted_pixel", owner: "code", provider: "meta", target: "capture", text: "Save click ids", evidence: { file: pixel, line: 1 } }], serverLane: null, npm: null, sensitivePaths: [], sources: { [pixel]: "fbq('consent', 'revoke');", [entry]: "export default function App() { return null }" }, managedCapture: { canWire, module: "lib/infinite-meta-click-id.js", entrypoints: canWire ? [entry] : [], editEntrypoints: canWire ? [entry] : [], pixelFiles: [pixel], strategy: "first_import", requirements: canWire ? [] : [{ path: entry, reason: "Entry handles owner consent", snippet: 'import "../lib/infinite-meta-click-id.js"', ownerBoundary: { kind: "frozen_unit", file: entry, line: 1 } }] } } })
  const capture = [...plan.scopedCandidates ?? [], ...plan.seeds].find(item => item.id === "meta_improve:capture")!
  expect(capture.owner).toBe("code")
  expect(capture.state).toBe(canWire ? "pending" : "left_for_you")
  expect(capture.allow.files).not.toContain(pixel)
  expect(plan.lines.some(line => line.id === "agent_budget")).toBe(false)
  if (canWire) {
    expect(capture.allow.files).toEqual([entry])
    expect(capture.checks.map(check => `${check.tier}:${check.id}`)).toEqual(["S:click_id_capture", "T0:fbc_capture", "PV:meta_seen_leaving"])
    expect(plan.lines.find(line => line.kind === "capture_beside_adopted_pixel")?.requires).toBe("info")
  } else {
    expect(capture.ownerBoundary?.file).toBe(entry)
    expect(capture.ownerBoundary?.wiring).toContain("infinite-meta-click-id")
    expect(capture.note).toContain("does not save")
  }
})

it("shows the inferred Meta goal without asking for another approval", () => {
  const plan = buildPlanModel({ ...base, candidates: [{ id: "conversions_to_tools:purchase", jobId: "conversions_to_tools", n: 10, title: "Purchase", owner: "agent", state: "pending", allow: { files: ["src/buy.ts"], create: [] }, checks: [], trigger: { finding: "Purchase", evidence: [{ file: "src/buy.ts", line: 1 }] } }], scan: { framework: "next-app-router", managedProviders: [], adopted: [], improve: [], serverLane: null, npm: null, sensitivePaths: [] } })
  expect(plan.lines.find(line => line.kind === "meta_goal")?.requires).toBe("info")
})
