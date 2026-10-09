// The site owner's hand-off for server conversions (review P0-6).
//
// The agent ALWAYS writes the server code in the pull request (the Stripe webhook route, the checkout and
// lead reports). That code is inert until its environment variables exist, and some steps only the owner
// can take: declaring the conversions in Infinite, generating the server-event secret, pasting the
// variables into the host, adding the Stripe webhook endpoint, connecting Meta and verifying the domain.
// The wizard writes those steps into the pull request as a plain file (`docs/infinite-server-events.md`)
// and as a section of the pull request's description. Every word comes from `serverLaneWizardCopy.handoff`.
import { join } from "node:path"

import { computeContentHash } from "../manifest.js"
import type { InstallManifest } from "../types.js"

import { serverLaneWizardCopy, type ServerEventsHandoffFacts } from "./copy.js"

export type { ServerEventsHandoffFacts } from "./copy.js"

/** Where the hand-off lives in the customer's repo (app-relative). */
export const SERVER_EVENTS_HANDOFF_FILE = "docs/infinite-server-events.md"

/** First line of the written file: the managed banner, so uninstall can recognize it. */
export const SERVER_EVENTS_HANDOFF_BANNER = "<!-- Managed by Infinite (infinite-tag). Your steps to turn on server conversions. -->"

/** The conversions that reach Meta from the site's server through Infinite (never from the page). */
export const SERVER_CONVERSION_NAMES = new Set([
  "purchase",
  "begin_checkout",
  "lead",
  "sign_up",
  "start_trial",
  "subscribe",
  "add_payment_info"
])

/** The approved conversion names that need the server lane, in plan order. */
export function serverConversionsOf(conversionNames: readonly string[]): string[] {
  return [...new Set(conversionNames.filter((name) => SERVER_CONVERSION_NAMES.has(name)))]
}

/** The whole file, Markdown. Pure and deterministic for the same facts. */
export function renderServerEventsHandoff(facts: ServerEventsHandoffFacts): string {
  const copy = serverLaneWizardCopy.handoff
  return [
    SERVER_EVENTS_HANDOFF_BANNER,
    `# ${copy.title}`,
    "",
    copy.intro(facts),
    "",
    ...copy.steps(facts).flatMap((step, index) => [`${index + 1}. ${step}`]),
    "",
    copy.untilThen(facts),
    ""
  ].join("\n")
}

/** The pull request description's section: the same steps, pointing at the file in the PR. */
export function renderServerEventsPrSection(facts: ServerEventsHandoffFacts, handoffPath: string): string {
  const copy = serverLaneWizardCopy.handoff
  return [
    `## ${copy.prHeading}`,
    "",
    copy.prIntro(handoffPath),
    "",
    ...copy.steps(facts).map((step, index) => `${index + 1}. ${step}`)
  ].join("\n")
}

/**
 * The PR section for a repo whose install receipt records the hand-off, or null. Reads the receipt and the
 * file through `readText` (the wizard's own fs), so the section always matches the file in the PR.
 */
export async function serverEventsPrSectionFromRepo(
  root: string,
  readText: (path: string) => Promise<string | null>
): Promise<string | null> {
  const read = await serverEventsStepsFromRepo(root, readText)
  if (!read) return null
  const copy = serverLaneWizardCopy.handoff
  return [`## ${copy.prHeading}`, "", copy.prIntro(read.file), "", ...read.steps.map((step, index) => `${index + 1}. ${step}`)].join("\n")
}

/**
 * The hand-off's numbered steps (without their numbers) and its path, for a repo whose install receipt records it, or
 * null. The report keeps them ("Before purchases reach Meta, do these steps"), word for word as the file says them.
 */
export async function serverEventsStepsFromRepo(
  root: string,
  readText: (path: string) => Promise<string | null>
): Promise<{ file: string; steps: string[] } | null> {
  const receiptText = await readText(join(root, ".infinite", "install.json"))
  if (!receiptText) return null
  let receipt: Partial<InstallManifest>
  try {
    receipt = JSON.parse(receiptText) as Partial<InstallManifest>
  } catch {
    return null
  }
  const handoffPath = (receipt.serverLane?.created ?? []).find((path) => path.endsWith(SERVER_EVENTS_HANDOFF_FILE))
  if (!handoffPath) return null
  const text = await readText(join(root, handoffPath))
  if (!text || !text.startsWith(SERVER_EVENTS_HANDOFF_BANNER)) return null
  const steps = text.split("\n").filter((line) => /^\d+\. /.test(line)).map((line) => line.replace(/^\d+\. /, ""))
  return { file: handoffPath, steps }
}

/**
 * Record the written hand-off in an install receipt as a lane-created file (hash-gated removal on
 * uninstall, committed with the rest of the lane). Pure: returns the new receipt.
 */
export function withHandoffInReceipt(receipt: InstallManifest, rootRelativePath: string, contents: string): InstallManifest {
  const lane = receipt.serverLane ?? { mode: "brief" as const }
  return {
    ...receipt,
    serverLane: { ...lane, created: [...new Set([...(lane.created ?? []), rootRelativePath])] },
    configOwnership: { ...(receipt.configOwnership ?? {}), [rootRelativePath]: { kind: "created", installedHash: computeContentHash(contents) } }
  }
}
