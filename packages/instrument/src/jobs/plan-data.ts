// What the user's approved plan decided, in the shape the registry and the briefs need (lane O8).
//
// Conversion names are user decisions. Policy text is a legacy field, always null; never agent work.
// The agent never chooses them: `applyApprovals` keeps a conversion job only for a type the user
// approved a name for, and the brief hands the agent that name, and the approved paragraph, as DATA.
//
// Reading the answers: the approved value of an editable decision line is its edit when one was given
// (the plan ask's `edits[lineId]`), else the plan's proposal; nothing counts unless the line itself is
// approved (and not declined).
import { CONVERSION_NAME_PATTERN, type ConversionType, type TagKeys } from "../wizard/contracts/bridge.js"
import type { PlanLine, PlanLineKind } from "../wizard/contracts/asks.js"
import type { PlanApprovals, PlanModel } from "../wizard/contracts/jobs.js"

/** The approved lines of one kind (approved and not declined). */
export function approvedLinesOfKind(plan: Pick<PlanModel, "lines">, approvals: PlanApprovals, kind: PlanLineKind): PlanLine[] {
  const declined = new Set(approvals.declined)
  const approved = new Set(approvals.approved)
  return plan.lines.filter((line) => line.kind === kind && approved.has(line.id) && !declined.has(line.id))
}

function parseNames(value: string): string[] {
  const names = value
    .split(/[\s,·]+/)
    .map((name) => name.trim())
    .filter((name) => name !== "")
  return names.every((name) => CONVERSION_NAME_PATTERN.test(name)) ? [...new Set(names)] : []
}

/** The conversion names the user approved (after their edit), or [] when the line is not approved. */
export function approvedConversionNames(plan: PlanModel, approvals: PlanApprovals): string[] {
  const lines = approvedLinesOfKind(plan, approvals, "conversion_names")
  if (lines.length === 0) return []
  const names = new Set<string>()
  for (const line of lines) {
    const edit = approvals.edits[line.id]
    const chosen = edit !== undefined ? parseNames(edit) : plan.decisions.conversionNames.filter((name) => CONVERSION_NAME_PATTERN.test(name))
    for (const name of chosen) names.add(name)
  }
  return [...names].sort()
}

/** Kept to decode old plan files; a saved approval never authorizes policy edits now. */
export function approvedPrivacyText(_plan: PlanModel, _approvals: PlanApprovals): string | null {
  return null
}

/**
 * The words a conversion NAME uses for each detected conversion TYPE. A name binds to a type when it is
 * the type itself or one of these (an approved `start_free_trial` binds the detected `trial` handler).
 * A name that binds to no type gets no detected job: the agent never guesses where it fires.
 */
const TYPE_NAMES: Record<ConversionType, RegExp> = {
  signup: /^(?:signup|sign_up|signups|register|registration|registered|create_account|account_created|app_signup)$/,
  lead: /^(?:lead|leads|contact|contact_form|contact_sales|demo_request|request_demo|enquiry|inquiry|quote_request)$/,
  booking: /^(?:booking|bookings|book|book_demo|book_call|schedule|scheduled|appointment|meeting_booked|demo_booked)$/,
  purchase: /^(?:purchase|purchases|order|order_completed|checkout_completed|paid|payment)$/,
  trial: /^(?:trial|trials|start_trial|started_trial|trial_start|trial_started|start_free_trial|free_trial)$/,
  download: /^(?:download|downloads|download_app|app_download)$/,
  custom: /^custom$/
}

/** The approved names that bind to one detected conversion type (sorted). */
export function boundConversionNames(type: string, approvedNames: readonly string[]): string[] {
  const pattern = (TYPE_NAMES as Record<string, RegExp | undefined>)[type]
  if (!pattern) return []
  return approvedNames.filter((name) => pattern.test(name)).sort()
}

/** One approved plan line the brief quotes for the items it names. */
export interface BriefPlanLine {
  id: string
  kind: PlanLineKind
  text: string
  jobIds: string[]
}

/** The approved plan, as the brief carries it. */
export interface BriefPlan {
  /** Approved conversion names (after the user's edits). */
  conversionNames: string[]
  /** Legacy persistence field; always null in current briefs. */
  privacyText: string | null
  /** Every approved line that names checklist items. */
  lines: BriefPlanLine[]
}

export function briefPlanFrom(plan: PlanModel, approvals: PlanApprovals): BriefPlan {
  const declined = new Set(approvals.declined)
  const approved = new Set(approvals.approved)
  return {
    conversionNames: approvedConversionNames(plan, approvals),
    privacyText: approvedPrivacyText(plan, approvals),
    lines: plan.lines
      .filter((line) => approved.has(line.id) && !declined.has(line.id) && (line.jobIds?.length ?? 0) > 0)
      .map((line) => ({ id: line.id, kind: line.kind, text: line.text, jobIds: [...(line.jobIds ?? [])] }))
  }
}

/** The public IDs of the user's connections (from the keys verb; never a secret). */
export interface BriefConnections {
  ga4MeasurementIds: string[]
  posthog: { projectKey: string | null; uiHost: string | null; region: "us" | "eu" | "self_hosted" | null } | null
  metaPixelIds: string[]
}

export function briefConnectionsFrom(keys: TagKeys): BriefConnections {
  return {
    ga4MeasurementIds: keys.ga4.status === "connected" ? keys.ga4.streams.map((stream) => stream.measurementId).sort() : [],
    posthog:
      keys.posthog.status === "connected" ? { projectKey: keys.posthog.projectKey, uiHost: keys.posthog.uiHost, region: keys.posthog.region } : null,
    metaPixelIds: keys.meta.status === "connected" ? keys.meta.pixels.map((pixel) => pixel.pixelId).sort() : []
  }
}
