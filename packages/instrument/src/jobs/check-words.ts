import type { ChecklistItemCheck } from "../wizard/contracts/jobs.js"

/** Founder-facing names. Keep technical identifiers in check records, not in job notes. */
export const CHECK_LABELS: Readonly<Record<string, string>> = {
  meta_host_matrix: "Meta refuses data from preview addresses",
  meta_traffic_permissions: "Meta accepts your site's domain",
  preview_self_silent: "Previews send nothing",
  posthog_distinct_id_receipt: "PostHog received this visit",
  server_lane_probe_receipt: "Server reporting reached Infinite",
  ga4_loader_id: "GA4 ID matches your connection",
  ga4_id_applied: "GA4 setup matches your connection",
  spa_page_view_applied: "Page-change tracking is in the code",
  byte_census: "Each tag once per page",
  one_beacon_per_tool: "Each tag once per page",
  ga4_spa_page_view: "GA4: one page view per page change",
  meta_spa_page_view: "Meta: one page view per page change",
  ga4_seen_leaving: "GA4 sent data from the visit",
  meta_seen_leaving: "Meta sent data from the visit",
  ga4_one_page_view: "GA4 counts each page once",
  meta_pixel_once: "Meta counts each page once",
  posthog_via_proxy_once: "PostHog sends once through your site",
  server_lane_mount_order: "Server reporting runs before page handling",
  build: "The site builds",
  rescan_app_found: "The tag is in your app",
  one_runtime_per_page: "One Infinite tag per page",
  posthog_config: "PostHog settings",
  next_rewrites_exact: "PostHog sends through your site",
  posthog_improve_applied: "PostHog settings updated",
  click_id_capture: "Ad click details are kept",
  meta_event_id_from_helper: "Meta event IDs match",
  meta_mirror_wired: "Meta events are also recorded by Infinite",
  meta_autoconfig_off: "Meta automatic events are off",
  fbc_capture: "Meta ad click details are kept",
  census_one_per_tool: "Each tag once per page",
  census_posthog_init_once: "PostHog starts once per page",
  census_ga4_config_once: "GA4 starts once per page",
  census_meta_init_once: "Meta starts once per page",
  adopted_init_guarded: "Existing tags stay silent on previews",
  host_matrix: "Tags run only on allowed addresses",
  outcome_after_success: "Conversions are sent only after success",
  outcome_declared: "Conversion names are declared",
  event_id_stable: "Conversion IDs stay consistent",
  no_pii_in_outcome: "Conversions exclude personal details",
  outcome_ad_match: "Server conversions carry Meta match data",
  tracking_signal_carried: "Your pages tell the server when a visitor allowed tracking",
  outcome_value_currency: "Purchases carry their value and currency",
  commerce_promises_met: "Every promised event is in the code",
  no_double_count: "No event is counted twice",
  meta_event_id_from_server: "Meta event IDs come from your server",
  sends_before_leaving: "Events are out before the page changes",
  first_real_outcome: "A real server conversion arrived",
  identify_on_auth_success: "Signed-in visits are linked to the account",
  reset_on_every_signout: "Account tracking resets on sign-out",
  first_identify: "A signed-in visit arrived",
  click_test: "The right buttons send conversions",
  no_fbq_standard_on_click: "Clicks do not pretend to be completed conversions",
  conversion_tracked: "Conversion tracking is in the code",
  track_after_success: "Conversions are sent only after success",
  first_real_conversion: "A real conversion reached your tools",
  setup_rerun_clean: "Setup checks pass",
  csp_hosts: "Your security policy allows the tags",
  csp_header: "Your live security policy allows the tags",
  no_csp_violation: "Your security policy does not block the tags",
  redirect_walk: "Campaign details survive redirects",
  build_green_or_baseline: "No new build failures",
  pr_checks_pass: "Pull request checks pass",
  turn_gate: "Changes stay within the approved work"
}

const RECEIPT_WORDS: Record<string, string> = {
  no_receipt: "Infinite has no receipt", pending: "still arriving", delivering: "sent, but receipt is not confirmed",
  undetermined: "receipt could not be checked", not_verifiable: "receipt cannot be checked", verified: "this visit was received"
}

export function plainCheckDetail(reason: string | undefined, checkId?: string): string {
  if (!reason) return ""
  const receipt = /^receipt (\w+)$/.exec(reason)
  if (receipt) {
    if (checkId === "posthog_distinct_id_receipt") {
      if (receipt[1] === "no_receipt") return "PostHog has no record of this visit"
      if (receipt[1] === "pending") return "still arriving in PostHog"
    }
    return RECEIPT_WORDS[receipt[1]!] ?? "receipt could not be checked"
  }
  const masked: string[] = []
  const text = reason.replace(/(?:G-[A-Z0-9]+|phc_[A-Za-z0-9]+)(?:\.{3}|…)[A-Za-z0-9]+/g, id => {
    masked.push(id)
    return `MASKEDID${masked.length - 1}TOKEN`
  })
  const tools: Record<string, string> = { ga4: "GA4", posthog: "PostHog", meta: "Meta", infinite: "Infinite" }
  return text.replace(/^[a-z][a-z0-9_]+\s*(?:—|:)\s*/i, prefix => prefix.includes("_") ? "" : prefix)
    .replace(/\bG-[A-Z0-9]+\b/g, "GA4").replace(/\bphc_[A-Za-z0-9]+\b/g, "PostHog")
    .replace(/\b(ga4|posthog|meta|infinite)\b/gi, token => tools[token.toLowerCase()]!)
    .replace(/\bpreview_self\b/g, "the preview address").replace(/\bhome\b(?! page)/g, "the home page")
    .replace(/\$pageview\b|\b(?:page_view|PageView)\b/g, "page views")
    .replace(/\b1 page views\b/g, "1 page view")
    .replace(/\b1 page loads\b/g, "1 page load")
    .replace(/\b(\d+) (?:page )?load\(s\)/g, (_text, count: string) => `${count} page ${count === "1" ? "load" : "loads"}`)
    .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, "")
    .replace(/\b(GA4|PostHog|Meta|Infinite): \1 /g, "$1 ")
    .replace(/MASKEDID(\d+)TOKEN/g, (_text, index: string) => masked[Number(index)]!)
    .replace(/\s+/g, " ").trim()
}

export function checkWords(checks: readonly Pick<ChecklistItemCheck, "id" | "reason">[]): string {
  return [...new Set(checks.map(check => {
    const label = CHECK_LABELS[check.id] ?? "An unrecognized analytics check"
    const detail = plainCheckDetail(check.reason, check.id)
    return `${label}${detail ? ` (${detail})` : ""}`
  }))].join("; ")
}
