import { describe, expect, it } from "vitest"
import { JOB_IDS, type JobId } from "../wizard/contracts/jobs.js"
import { planExclusions } from "./plan-exclusions.js"

// Every registry kind explicitly states whether it requires the installed Infinite runtime.
const needsInfinite: Record<JobId, boolean> = {
  server_lane_mount: true, unusual_layout: false, posthog_improve: false, ga4_improve: false,
  meta_improve: false, duplicates_remove: false, preview_guard: false, server_conversions: true,
  identify_reset: true, conversions_to_tools: true, setup_check_fixes: false, csp: false,
  redirect_utms: false, privacy_paragraph: false, build_fix: false, review_comments: false
}
const ids = ["install_provider:infinite", "info:infinite_site_file", "user_action:next_config_rewrites"]
describe("explicit exclusion prerequisites", () => {
  it.each(ids)("removes all Infinite-dependent jobs after declining %s", excluded => {
    const effects = planExclusions({ lines: ids.map(id => ({ id })) }, [excluded])
    for (const jobId of JOB_IDS) {
      expect(effects.blocksJob({ jobId, id: `${jobId}:auth` }), jobId).toBe(needsInfinite[jobId])
    }
    expect(effects.blocksJob({ jobId: "unusual_layout", id: "unusual_layout:next_config_rewrites" })).toBe(true)
    expect(effects.consequences.join(" ")).toContain("account identity/reset")
  })
  it.each(JOB_IDS)("removes %s when any excludable line explicitly owns it", jobId => {
    for (const id of ["preview_guard_adopted:meta", "sensitive_pages:posthog", "capture_beside_adopted_pixel", "meta_spa_page_views", "conversion_names", "account_settings:ga4", "server_lane", ...ids]) {
      const item = { jobId, id: `${jobId}:fixture` }
      expect(planExclusions({ lines: [{ id, jobIds: [item.id] }] }, [id]).blocksJob(item), id).toBe(true)
    }
  })
})
