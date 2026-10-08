import { expect, it } from "vitest"
import { JOB_TABLE, TARGET_ONLY_CHECKS } from "../wizard/contracts/jobs.js"
import { CHECK_LABELS, checkWords, plainCheckDetail } from "./check-words.js"

it("request 3 labels: every job check that can reach a note has a plain label", () => {
  for (const id of new Set([...Object.values(JOB_TABLE).flatMap(job => job.checks.map(check => check.checkId)), ...Object.values(TARGET_ONLY_CHECKS).flatMap(checks => (checks ?? []).map(check => check.checkId)), "turn_gate"])) {
    expect(CHECK_LABELS[id], `missing label for ${id}`).toBeTruthy()
    expect(CHECK_LABELS[id]).not.toContain("_")
  }
})
it("request 3 labels: plain details retain measured counts but drop tiers, codes and receipt enums", () => {
  expect(checkWords([{ id: "one_beacon_per_tool", reason: "duplicate_page_view — GA4 sent 2 page_view" }])).toBe("Each tag once per page (GA4 sent 2 page views)")
  expect(checkWords([{ id: "posthog_distinct_id_receipt", reason: "receipt pending" }])).toBe("PostHog received this visit (still arriving in PostHog)")
  expect(checkWords([{ id: "meta_host_matrix" }])).toBe("Meta refuses data from preview addresses")
})

it("request 4 P2-2: receipt details name the provider that has the record", () => {
  expect(checkWords([{ id: "posthog_distinct_id_receipt", reason: "receipt no_receipt" }])).toBe("PostHog received this visit (PostHog has no record of this visit)")
  expect(checkWords([{ id: "posthog_distinct_id_receipt", reason: "receipt pending" }])).toBe("PostHog received this visit (still arriving in PostHog)")
  expect(checkWords([{ id: "server_lane_probe_receipt", reason: "receipt no_receipt" }])).toBe("Server reporting reached Infinite (Infinite has no receipt)")
})

it.each([
  ["duplicate_page_view — posthog: phc_abc sent 2 $pageview in 1 load(s)", "PostHog sent 2 page views in 1 page load"],
  ["duplicate_page_view — ga4: G-ABC123 sent 2 page_view on preview_self; posthog: phc_abc sent 2 $pageview on home", "GA4 sent 2 page views on the preview address; PostHog sent 2 page views on the home page"],
  ["not_exercised — ga4, posthog and meta could not be graded", "GA4, PostHog and Meta could not be graded"],
  ["wrong_id — G-ABCD...1234 is not the connected ID", "G-ABCD...1234 is not the connected ID"],
  ["Meta sent 3 PageView in 2 load(s)", "Meta sent 3 page views in 2 page loads"],
  ["Meta sent 2 page views in 1 page loads", "Meta sent 2 page views in 1 page load"]
])("request 4 P3-detail: %s", (raw, plain) => {
  expect(plainCheckDetail(raw)).toBe(plain)
})

it("request 4 P3-labels: probe and page-change labels identify what was measured", () => {
  expect(CHECK_LABELS.server_lane_probe_receipt).toBe("Server reporting reached Infinite")
  expect(CHECK_LABELS.ga4_spa_page_view).toBe("GA4: one page view per page change")
  expect(CHECK_LABELS.meta_spa_page_view).toBe("Meta: one page view per page change")
})
