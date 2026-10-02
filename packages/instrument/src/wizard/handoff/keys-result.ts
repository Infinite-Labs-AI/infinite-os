// What the `keys` step decided, for the `plan` step (lane O7) and `settings`: which GA4 stream and Meta pixel
// are this site's, how the connection's IDs compare with what `before` saw, and the plan lines that follow.
//
// Kept in `.infinite/wizard/keys.json` (gitignored, 0600). It holds CHOICES among the connection's own IDs and
// the comparison, never a key from anywhere else: wizard keys come from the bridge `keys` verb only (R2-16);
// the plan re-reads the verb and applies these choices. A mismatch between the live site and the connection is
// a plan line the user sees, never an overwrite.
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
  at: string
  linkId: string | null
  /** sha256 of the keys response the choices were made against (the plan re-reads keys; a change → re-run keys). */
  keysDigest: string
  choices: KeysChoices
  comparisons: KeysToolComparison[]
  /** Plan lines for O7's PlanModel (connect / reconnect / mismatch / Infinite's own dataset / Vercel permission). */
  lines: PlanLine[]
  /** False when the workspace's pixel is Infinite's own (or there is no usable pixel): Meta is never installed. */
  metaInstall: boolean
}

export function keysDigest(keys: TagKeys): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(keys)).digest("hex")}`
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

/** The saved result, or null when missing, unreadable or another schema. */
export async function readKeysResult(fs: WizardFs, root: string): Promise<KeysStepResult | null> {
  const text = await fs.readText(join(root, KEYS_RESULT_PATH))
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as Partial<KeysStepResult>
    if (parsed.schema !== KEYS_RESULT_SCHEMA || typeof parsed.choices !== "object" || parsed.choices === null || !Array.isArray(parsed.lines)) return null
    return parsed as KeysStepResult
  } catch {
    return null
  }
}
