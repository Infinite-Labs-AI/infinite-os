// Review I1 P1-5: an agent job the wizard could not check ships its code in the PR, and the PR says so.
import { describe, expect, it } from "vitest"

import type { ChecklistItem } from "../contracts/jobs.js"
import { notCheckedNotes } from "./rehearsal.js"

const base = (state: ChecklistItem["state"], owner: ChecklistItem["owner"] = "agent"): ChecklistItem => ({
  id: "identify_reset:auth",
  jobId: "identify_reset",
  n: 9,
  title: "Join visits to accounts",
  owner,
  trigger: { finding: "f", evidence: [] },
  allow: { files: ["app/api/auth/login/route.ts"], create: [] },
  checks: [],
  state,
  edits: [{ editId: "agent-1", file: "app/api/auth/login/route.ts" }]
})

describe("notCheckedNotes", () => {
  it("request 2 P3-1: the pre-rehearsal note defers to the rehearsal rather than permanently declaring unreviewed code", () => {
    const [note] = notCheckedNotes([base("claimed")])
    expect(note).toContain("Not checked at pull request creation")
    expect(note).toContain("what-happened comment")
    expect(note).not.toContain("Review it yourself")
    expect(note).toContain("Join visits to accounts (app/api/auth/login/route.ts)")
  })
  it("negative: checked, failed or code-owned jobs add no note", () => {
    expect(notCheckedNotes([base("done_in_code"), base("waiting_real_event"), base("failed"), base("claimed", "code")])).toEqual([])
  })
})


it("request 3 P3-body: name only jobs actually checked by rehearsal; no clause when none ran", () => {
  const spa = { ...base("claimed"), id: "ga4_improve:spa_page_view", title: "GA4 page changes", checks: [{ id: "ga4_spa_page_view", tier: "RH" as const, state: "not_run" as const }] }
  const notes = notCheckedNotes([base("claimed"), spa], [spa.id]).join(" ")
  expect(notes).toContain("The preview rehearsal checked: GA4 page changes.")
  expect(notes).not.toContain("The preview rehearsal checked: Join visits")
  expect(notCheckedNotes([base("claimed"), spa]).join(" ")).not.toContain("rehearsal")
})
