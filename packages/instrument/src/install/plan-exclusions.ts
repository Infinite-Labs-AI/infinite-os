import type { PlanLineKind } from "../wizard/contracts/asks.js"
import type { SetupCheckId } from "../setup-checks/types.js"
import type { ChecklistItem } from "../wizard/contracts/jobs.js"

export interface ExclusionPlan {
  lines: readonly { id: string; kind?: PlanLineKind; jobIds?: string[]; text?: string }[]
  managedTools?: readonly string[]
}

// Broad setup jobs cannot safely perform only half a check: exclude the whole alternate repair path.
const SETUP_REPAIRS: Partial<Record<PlanLineKind, readonly SetupCheckId[]>> = {
  install_provider: ["provider_census"],
  remove_duplicate: ["provider_census"],
  preview_guard_managed: ["host_guard"],
  preview_guard_adopted: ["host_guard"],
  sensitive_pages: ["sensitive_pages", "posthog_config"],
  improve_additive: ["provider_census", "posthog_config"],
  posthog_defaults_bump_adopted: ["posthog_config"],
  capture_beside_adopted_pixel: ["click_id_capture"],
  retire_fbc_writer: ["click_id_capture"],
  autoconfig_off_adopted: ["meta_pixel_config"],
  meta_spa_page_views: ["meta_pixel_config"],
  conversion_names: ["conversion_placement", "silent_form", "meta_event_id"]
}

/** Explicit dependency table for exclusions. No source/text inference: every path uses these same effects. */
export function planExclusions(plan: ExclusionPlan, excluded: readonly string[]) {
  const lineIds = new Set(excluded)
  const jobIds = new Set<string>()
  const jobKinds = new Set<string>()
  const block = (...ids: string[]) => ids.forEach(id => lineIds.add(id))
  const noInfinite = lineIds.has("install_provider:infinite") || lineIds.has("info:infinite_site_file") || lineIds.has("user_action:next_config_rewrites")
  if (noInfinite) {
    // The tag owns the collect rewrite, source/claim/proof file and server-lane package/settings.
    block("install_provider:infinite", "info:infinite_site_file", "user_action:next_config_rewrites", "server_lane", "npm_install", "account_settings:hosting")
    jobIds.add("unusual_layout:next_config_rewrites")
    jobKinds.add("identify_reset")
  }
  if (lineIds.has("server_lane")) {
    block("npm_install", "account_settings:hosting")
    jobKinds.add("server_lane_mount")
    jobKinds.add("server_conversions")
  }
  const providerLines = plan.lines.filter(line => line.id.startsWith("install_provider:"))
  const excludesProvider = providerLines.some(line => lineIds.has(line.id))
  const helpersRemain = providerLines.some(line => !lineIds.has(line.id)) || (plan.managedTools?.length ?? 0) > 0
  if (excludesProvider && !helpersRemain) block("conversion_names")
  if (lineIds.has("conversion_names")) {
    jobKinds.add("conversions_to_tools")
    jobKinds.add("server_conversions")
    for (const check of SETUP_REPAIRS.conversion_names ?? []) jobIds.add(`setup_check_fixes:${check}`)
  }
  for (const line of plan.lines) {
    if (!lineIds.has(line.id)) continue
    for (const id of line.jobIds ?? []) jobIds.add(id)
    for (const check of line.kind ? SETUP_REPAIRS[line.kind] ?? [] : []) jobIds.add(`setup_check_fixes:${check}`)
  }
  return {
    lineIds,
    consequences: noInfinite ? ["Infinite’s tag, site claim/proof file, collect rewrite, server lane, account identity/reset calls and Infinite conversion declarations are excluded."] : [],
    blocksJob: (item: Pick<ChecklistItem, "id" | "jobId">) => jobIds.has(item.id) || jobKinds.has(item.jobId),
    // Cloud and connected-account actions are separate from the emitted browser helpers.
    infiniteWrites: !noInfinite,
    conversionWrites: !noInfinite && !lineIds.has("conversion_names"),
    hostingWrites: !lineIds.has("account_settings:hosting"),
    ga4Writes: !lineIds.has("account_settings:ga4") && !lineIds.has("conversion_names"),
    metaRelayWrites: !lineIds.has("meta_relay")
  }
}
