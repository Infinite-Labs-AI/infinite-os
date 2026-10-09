import type { PlanLine } from "../wizard/contracts/asks.js"
const REPO_WORK = new Set<PlanLine["kind"]>(["install_provider", "server_lane", "preview_guard_managed", "improve_additive", "remove_duplicate", "preview_guard_adopted", "autoconfig_off_adopted", "sensitive_pages", "posthog_defaults_bump_adopted", "capture_beside_adopted_pixel", "retire_fbc_writer", "meta_spa_page_views", "ga4_spa_page_views", "meta_advanced_matching"])
export function isRepositoryWork(line: Pick<PlanLine, "kind">): boolean { return REPO_WORK.has(line.kind) }
export function isContinuedWork(line: PlanLine): boolean { return line.requires === "info" && !line.editable && isRepositoryWork(line) }
