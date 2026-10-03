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
  it("names each claimed agent job and its files as not checked by the wizard", () => {
    const [note] = notCheckedNotes([base("claimed")])
    expect(note).toContain("Not checked by the wizard")
    expect(note).toContain("Join visits to accounts (app/api/auth/login/route.ts)")
  })
  it("negative: checked, failed or code-owned jobs add no note", () => {
    expect(notCheckedNotes([base("done_in_code"), base("waiting_real_event"), base("failed"), base("claimed", "code")])).toEqual([])
  })
})
