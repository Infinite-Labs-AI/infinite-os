// What the `keys` step decided, for the `plan` step (lane O7) and `settings`: which GA4 stream and Meta pixel
// are this site's, how the connection's IDs compare with what `before` saw, and the plan lines that follow.
//
// Kept in `.infinite/wizard/keys.json` (gitignored, 0600), scoped to the run that wrote it. It holds CHOICES
// among the connection's own IDs and the comparison, never a key from anywhere else: wizard keys come from the
// bridge `keys` verb only (R2-16). A reader applies the choices to the keys it read itself with
// `applyKeysChoices` (the plan / install steps do this before building the installer's input, so a user's
// "which GA4 stream?" / "which pixel?" answer is never dropped). A mismatch between the live site and the
// connection is a plan line the user sees, never an overwrite.
import { createHash } from "node:crypto"
import { join } from "node:path"

import type { PlanLine } from "../contracts/asks.js"
import type { TagKeys } from "../contracts/bridge.js"
import type { WizardFs } from "../contracts/deps.js"
import { WIZARD_PATHS } from "../contracts/state.js"
import type { TestTool } from "../contracts/test-engine.js"
import type { ObservedIds } from "./before-facts.js"

export const KEYS_RESULT_PATH = `${WIZARD_PATHS.dir}/keys.json` as const
export const KEYS_RESULT_SCHEMA = "infinite-tag.wizard-keys.v1" as const

export type KeysCompareState = "pass" | "problem" | "undetermined" | "info"
export type KeysCompareReason =
  | "not_connected"
  | "read_failed"
  | "no_pixel"
  | "no_stream"
  | "infinite_dataset"
  | "not_provisioned"
  | "not_measured"
  | "not_on_site"
  | "mismatch"

export interface KeysToolComparison {
  tool: TestTool
  /** The connection's status as the keys verb reported it. */
  connection: string
  /** The connection's IDs this site should use (after the stream / pixel choice). */
  expected: string[]
  /** IDs the live site sent in `before`'s dry load (cancelled, nothing sent). */
  live: string[]
  /** Literal IDs in the code (`before`'s census). */
  inCode: string[]
  /** The finish line's `ids_match_connections` for this tool, as far as the keys step can tell. */
  state: KeysCompareState
  reason: KeysCompareReason | null
}

export interface KeysChoices {
  /** This site's GA4 stream (one of the connection's), or null. */
  ga4MeasurementId: string | null
  /** This site's Meta pixel (one of the connection's), or null. */
  metaPixel: { pixelId: string; sourceRef: string } | null
}

export interface KeysStepResult {
  schema: typeof KEYS_RESULT_SCHEMA
  /** The run this result belongs to: a reader for another run gets null. */
  runId: string
  at: string
  linkId: string | null
  /**
   * sha256 of the connections the choices were made against: the keys response WITHOUT its envelope
   * (`protocolVersion`, `requestId`), keys in canonical order, so the same connections always hash the same.
   */
  keysDigest: string
  choices: KeysChoices
  comparisons: KeysToolComparison[]
  /** Plan lines for O7's PlanModel (connect / reconnect / mismatch / Infinite's own dataset / Vercel permission). */
  lines: PlanLine[]
  /** False when the workspace's pixel is Infinite's own (or there is no usable pixel): Meta is never installed. */
  metaInstall: boolean
}

/** JSON with object keys sorted at every depth (arrays keep their order). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

/** The digest of the connections (the keys response without its bridge envelope). */
export function keysDigest(keys: TagKeys | (TagKeys & { protocolVersion?: unknown; requestId?: unknown })): string {
  const { protocolVersion: _version, requestId: _request, ...connections } = keys as TagKeys & { protocolVersion?: unknown; requestId?: unknown }
  return `sha256:${createHash("sha256").update(canonicalJson(connections)).digest("hex")}`
}

/**
 * The keys narrowed to this site's choices: GA4 keeps only the chosen stream and Meta only the chosen pixel
 * (status `connected`). A choice that is no longer among the connection's IDs narrows nothing, and Infinite's
 * own dataset is never turned into an installable pixel. Never adds an ID the keys verb did not return.
 */
export function applyKeysChoices<T extends TagKeys>(keys: T, result: Pick<KeysStepResult, "choices" | "metaInstall"> | null): T {
  const narrowed = structuredClone(keys)
  if (!result) return narrowed
  const streamId = result.choices.ga4MeasurementId
  if (streamId && narrowed.ga4.status === "connected") {
    const stream = narrowed.ga4.streams.filter((candidate) => candidate.measurementId === streamId)
    if (stream.length === 1) narrowed.ga4.streams = stream
  }
  const pixel = result.choices.metaPixel
  if (pixel && result.metaInstall && (narrowed.meta.status === "connected" || narrowed.meta.status === "multiple")) {
    const chosen = narrowed.meta.pixels.filter((candidate) => candidate.pixelId === pixel.pixelId && candidate.sourceRef === pixel.sourceRef)
    if (chosen.length === 1) narrowed.meta = { ...narrowed.meta, status: "connected", pixels: chosen }
  }
  return narrowed
}

const TOOL_LABEL: Record<TestTool, string> = { infinite: "Infinite", ga4: "GA4", posthog: "PostHog", meta: "Meta" }

function expectedFor(tool: TestTool, keys: TagKeys, choices: KeysChoices): string[] {
  switch (tool) {
    case "ga4":
      if (keys.ga4.status !== "connected") return []
      return choices.ga4MeasurementId ? [choices.ga4MeasurementId] : keys.ga4.streams.map((stream) => stream.measurementId)
    case "posthog":
      return keys.posthog.status === "connected" && keys.posthog.projectKey ? [keys.posthog.projectKey] : []
    case "meta":
      if (keys.meta.status !== "connected" && keys.meta.status !== "multiple") return []
      return choices.metaPixel ? [choices.metaPixel.pixelId] : keys.meta.pixels.map((pixel) => pixel.pixelId)
    case "infinite":
      return keys.infinite.status === "ready" && keys.infinite.siteSourceKey ? [keys.infinite.siteSourceKey] : []
  }
}

function connectionState(tool: TestTool, keys: TagKeys): { connection: string; blocked: { state: KeysCompareState; reason: KeysCompareReason } | null } {
  switch (tool) {
    case "ga4":
      if (keys.ga4.status === "not_connected") return { connection: "not_connected", blocked: { state: "undetermined", reason: "not_connected" } }
      if (keys.ga4.status === "read_failed") return { connection: "read_failed", blocked: { state: "undetermined", reason: "read_failed" } }
      if (keys.ga4.streams.length === 0) return { connection: "connected", blocked: { state: "undetermined", reason: "no_stream" } }
      return { connection: "connected", blocked: null }
    case "posthog":
      if (keys.posthog.status === "not_connected") return { connection: "not_connected", blocked: { state: "undetermined", reason: "not_connected" } }
      if (keys.posthog.status === "read_failed" || !keys.posthog.projectKey) {
        return { connection: keys.posthog.status, blocked: { state: "undetermined", reason: "read_failed" } }
      }
      return { connection: "connected", blocked: null }
    case "meta":
      if (keys.meta.status === "infinite_dataset") return { connection: "infinite_dataset", blocked: { state: "info", reason: "infinite_dataset" } }
      if (keys.meta.status === "not_connected") return { connection: "not_connected", blocked: { state: "undetermined", reason: "not_connected" } }
      if (keys.meta.status === "no_pixel" || keys.meta.pixels.length === 0) return { connection: keys.meta.status, blocked: { state: "undetermined", reason: "no_pixel" } }
      return { connection: keys.meta.status, blocked: null }
    case "infinite":
      if (keys.infinite.status === "not_provisioned") return { connection: "not_provisioned", blocked: { state: "info", reason: "not_provisioned" } }
      return { connection: "ready", blocked: null }
  }
}

/** Compare each tool's connection IDs with what `before` saw (null observed → `undetermined (not measured)`). */
export function compareKeys(
  keys: TagKeys,
  choices: KeysChoices,
  observed: { live: ObservedIds; inCode: ObservedIds; liveMeasured: boolean } | null
): KeysToolComparison[] {
  const tools: TestTool[] = ["infinite", "ga4", "posthog", "meta"]
  return tools.map((tool) => {
    const { connection, blocked } = connectionState(tool, keys)
    const expected = expectedFor(tool, keys, choices)
    const live = observed?.live[tool] ?? []
    const inCode = observed?.inCode[tool] ?? []
    const base = { tool, connection, expected, live, inCode }
    if (blocked) return { ...base, ...blocked }
    if (!observed) return { ...base, state: "undetermined", reason: "not_measured" }
    const seen = [...new Set([...live, ...inCode])]
    if (seen.length === 0) return { ...base, state: "info", reason: observed.liveMeasured ? "not_on_site" : "not_measured" }
    const wrong = seen.filter((id) => !expected.includes(id))
    if (wrong.length > 0) return { ...base, state: "problem", reason: "mismatch" }
    return { ...base, state: "pass", reason: null }
  })
}

function line(id: string, text: string, requires: PlanLine["requires"]): PlanLine {
  return { id, kind: "user_action", text, requires, editable: false }
}

/** The plan lines the keys step contributes (all `user_action` kinds: shown, never auto-approved). */
export function keysPlanLines(keys: TagKeys, comparisons: readonly KeysToolComparison[]): PlanLine[] {
  const lines: PlanLine[] = []
  for (const comparison of comparisons) {
    const label = TOOL_LABEL[comparison.tool]
    switch (comparison.reason) {
      case "not_connected":
        lines.push(
          line(
            `user_action:connect_${comparison.tool}`,
            `Connect ${label} in Infinite (Connections) to set it up here. The wizard never makes up a key, so ${label} is skipped until then.`,
            "user_action"
          )
        )
        break
      case "read_failed":
        lines.push(line(`user_action:reconnect_${comparison.tool}`, `Infinite could not read your ${label} connection. Reconnect it in Infinite (Connections), then run npx infinite-tag again.`, "user_action"))
        break
      case "no_stream":
        lines.push(line("user_action:ga4_web_stream", "Your GA4 property has no web stream. Add one in GA4 (Admin › Data streams), then run npx infinite-tag again.", "user_action"))
        break
      case "no_pixel":
        lines.push(line("user_action:meta_no_pixel", "Your Meta connection has no pixel. Add one in Meta Events Manager and pick it in Infinite, then run npx infinite-tag again.", "user_action"))
        break
      case "infinite_dataset":
        lines.push(
          line(
            "user_action:meta_infinite_dataset",
            "This workspace's Meta pixel is Infinite's own; it is never installed on a customer site. Meta is skipped.",
            "info"
          )
        )
        break
      case "mismatch": {
        const wrong = [...new Set([...comparison.live, ...comparison.inCode])].filter((id) => !comparison.expected.includes(id))
        const where = comparison.live.some((id) => wrong.includes(id)) ? "the live site sends" : "the code has"
        lines.push(
          line(
            `user_action:keys_mismatch_${comparison.tool}`,
            `${label}: ${where} ${wrong.join(", ")}, but your Infinite connection is ${comparison.expected.join(" or ")}. The wizard will not overwrite it: check which one is right in Infinite, then run npx infinite-tag again.`,
            "user_action"
          )
        )
        break
      }
      default:
        break
    }
  }
  if (!keys.serverLane.envWriteGranted) {
    lines.push(
      line(
        "user_action:vercel_env_write",
        "Let Infinite save the server-lane settings on Vercel: allow env-var writes in Infinite (Connections › Vercel).",
        "user_action"
      )
    )
  }
  return lines
}

export async function writeKeysResult(fs: WizardFs, root: string, result: KeysStepResult): Promise<void> {
  await fs.mkdirp(join(root, WIZARD_PATHS.dir), 0o700)
  await fs.writeTextAtomic(join(root, KEYS_RESULT_PATH), `${JSON.stringify(result, null, 2)}\n`, 0o600)
}

/** This run's saved result, or null when missing, unreadable, another schema, or written by another run. */
export async function readKeysResult(fs: WizardFs, root: string, runId: string | null): Promise<KeysStepResult | null> {
  if (runId === null) return null
  const text = await fs.readText(join(root, KEYS_RESULT_PATH))
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as Partial<KeysStepResult>
    if (parsed.schema !== KEYS_RESULT_SCHEMA || parsed.runId !== runId) return null
    if (typeof parsed.choices !== "object" || parsed.choices === null || !Array.isArray(parsed.lines)) return null
    return parsed as KeysStepResult
  } catch {
    return null
  }
}
