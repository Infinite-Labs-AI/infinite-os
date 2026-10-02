// `infinite-tag doctor`: the static setup checks plus the T1 live checks, with no browser, for CI and a
// quick look. Exit codes (§3d.5): 0 = no problem and nothing undetermined · 1 = at least one problem ·
// 3 = no problem but something undetermined · 2 = usage.
//
// THE RULES IT KEEPS:
//   • ids come from flags, or from the `ids` block of `.infinite/install.json` (§3e.6) — never a
//     default. With no ids at all it refuses (exit 2): a doctor with nothing to compare against would
//     read "clean" while checking nothing.
//   • every live probe declares itself a check (`Purpose: prefetch`), so doctor never counts as a visit.
//   • the server-lane probe is the one request MEANT to land in the customer's ledger, so it runs ONLY
//     with `--probe-server-lane` AND a linked Infinite app (R2-27) — a CI run never adds an unread bot
//     row. Otherwise, when the lane is installed, its cell is `undetermined (not probed)`.
//   • every check runs on its own; a crash is `undetermined (test error)`, and the summary LEADS with how
//     many checks could not tell (incident c912fa5 / 21b78ab: live checks hidden for two weeks because a
//     failing step stopped the rest and the summary never said so).
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import { checkCsp } from "../checks/live/csp.js"
import { checkLiveBytes } from "../checks/live/live-bytes.js"
import { checkMetaDomains } from "../checks/live/meta-domains.js"
import type { LiveFetch } from "../checks/live/probe.js"
import { checkRedirectWalk } from "../checks/live/redirects.js"
import { sendServerLaneProbe, serverLaneProbePath } from "../checks/live/server-lane-probe.js"
import { setupFindingResult } from "../checks/o9.js"
import { checkResult, isolated, summarizeResults } from "../checks/result.js"
import { installManifestPath, readInstallManifest } from "../manifest.js"
import { runSetupChecks } from "../setup-checks/index.js"
import { doctorExitCode } from "../wizard/contracts/codes.js"
import type { CheckResult, InstallManifestIds } from "../wizard/contracts/jobs.js"
import type { TestExpect } from "../wizard/contracts/test-engine.js"

export const DOCTOR_REPORT_SCHEMA = "infinite-tag.doctor.v1" as const

export interface DoctorIds {
  ga4: string[]
  posthog: { projectKey: string; apiHost: string } | null
  meta: string[]
  infinite: { siteSourceKey: string } | null
}

export interface DoctorOptions {
  root: string
  url: string | null
  /** Ids from flags; null = read `.infinite/install.json` `ids`. */
  flagIds: DoctorIds | null
  probeServerLane: boolean
}

/** What the server-lane receipt read returns (wired by the integration lane to the desktop bridge). */
export interface ServerLaneReceiptRead {
  state: "verified" | "pending" | "no_receipt" | "undetermined"
  reason: string | null
}

export interface DoctorDeps {
  version: string
  now(): Date
  fetch?: LiveFetch
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  /** Attempts per live request (default 2). */
  attempts?: number
  /** Is this repo linked to a running, signed-in Infinite app? Default: link record + bridge descriptor present. */
  linkedApp?: (root: string) => boolean
  /** Reads the probe's receipt through the Infinite app. Absent → the cell says where to read it. */
  readServerLaneReceipt?: (probePath: string) => Promise<ServerLaneReceiptRead>
  env?: Readonly<Record<string, string | undefined>>
  randomHex?: () => string
}

export interface DoctorReport {
  schema: typeof DOCTOR_REPORT_SCHEMA
  tagVersion: string
  root: string
  appRoot: string
  url: string | null
  ids: DoctorIds & { source: "flags" | "install.json" }
  results: CheckResult[]
  summary: { undetermined: number; problem: number; pass: number; info: number; total: number }
  exitCode: 0 | 1 | 3
}

export class DoctorUsageError extends Error {}

/** The `ids` block of `.infinite/install.json`, validated; null when absent. Throws on a malformed block. */
export function readManifestIds(root: string): DoctorIds | null {
  const path = installManifestPath(root)
  if (!existsSync(path)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    throw new DoctorUsageError("Corrupt .infinite/install.json — cannot parse it.")
  }
  const ids = (parsed as { ids?: unknown }).ids
  if (ids === undefined) return null
  const block = ids as Partial<InstallManifestIds> | null
  const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string")
  if (
    block === null ||
    typeof block !== "object" ||
    !strings(block.ga4) ||
    !strings(block.meta) ||
    !(block.posthog === null || (typeof block.posthog === "object" && typeof block.posthog?.projectKey === "string" && typeof block.posthog?.apiHost === "string")) ||
    !(block.infinite === null || (typeof block.infinite === "object" && typeof block.infinite?.siteSourceKey === "string"))
  ) {
    throw new DoctorUsageError("The ids block of .infinite/install.json is malformed; re-run npx infinite-tag.")
  }
  return {
    ga4: [...(block.ga4 as string[])],
    meta: [...(block.meta as string[])],
    posthog: block.posthog ? { projectKey: block.posthog.projectKey, apiHost: block.posthog.apiHost } : null,
    infinite: block.infinite ? { siteSourceKey: block.infinite.siteSourceKey } : null
  }
}

function hasAnyId(ids: DoctorIds): boolean {
  return ids.ga4.length > 0 || ids.meta.length > 0 || ids.posthog !== null || ids.infinite !== null
}

export function expectFromIds(ids: DoctorIds): TestExpect {
  const expect: TestExpect = {}
  if (ids.ga4.length > 0) expect.ga4 = ids.ga4
  if (ids.posthog) expect.posthog = ids.posthog
  if (ids.meta.length > 0) expect.meta = ids.meta
  // install.json carries the site key only; an empty collectPath means "not compared".
  if (ids.infinite) expect.infinite = { siteSourceKey: ids.infinite.siteSourceKey, collectPath: "" }
  return expect
}

/** Default "linked app": the wizard's link record AND a published desktop tag bridge (existence only; never read). */
export function defaultLinkedApp(root: string, env: Readonly<Record<string, string | undefined>>): boolean {
  let linkId: unknown
  try {
    const state = JSON.parse(readFileSync(join(root, ".infinite", "wizard", "state.json"), "utf8")) as { link?: { linkId?: unknown } }
    linkId = state.link?.linkId
  } catch {
    return false
  }
  if (typeof linkId !== "string" || !linkId.startsWith("lk_")) return false
  const home = env.GROWTH_OS_HOME && env.GROWTH_OS_HOME.length > 0 ? env.GROWTH_OS_HOME : join(homedir(), ".growth-os")
  return existsSync(join(home, "desktop-tag", "bridge.json"))
}

export async function runDoctor(options: DoctorOptions, deps: DoctorDeps): Promise<DoctorReport> {
  const root = resolve(options.root)
  const manifest = readInstallManifest(root)
  const appRoot = manifest ? resolve(root, manifest.appRoot) : root
  const manifestIds = options.flagIds ? null : readManifestIds(root)
  const ids = options.flagIds ?? manifestIds
  if (!ids || !hasAnyId(ids)) {
    throw new DoctorUsageError(
      "doctor needs the ids to check against: pass --expect-ga4 / --expect-posthog + --posthog-api-host / --expect-meta, or run it in a repo set up by npx infinite-tag (its .infinite/install.json carries them)."
    )
  }
  if (options.probeServerLane && !options.url) throw new DoctorUsageError("--probe-server-lane needs --url (the production site to probe).")

  const ctx = { runId: null, now: deps.now }
  const probeDeps = {
    version: deps.version,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.attempts ? { attempts: deps.attempts } : {})
  }
  const expect = expectFromIds(ids)
  const results: CheckResult[] = []

  // Static: the setup checks over the app's source.
  results.push(
    ...(await isolated("setup_checks", "S", ctx, async () =>
      runSetupChecks(appRoot, {
        ...(ids.posthog && !ids.posthog.apiHost.startsWith("/") ? { expectedPosthogApiHost: ids.posthog.apiHost } : {}),
        ...(options.url ? { productionHosts: [new URL(options.url).hostname] } : {})
      }).findings.map((finding) => setupFindingResult(finding, ctx))
    ))
  )

  // T1: the live checks, each on its own.
  if (options.url) {
    const url = options.url
    const host = new URL(url).hostname
    results.push(...(await isolated("live_bytes", "T1", ctx, () => checkLiveBytes({ urls: [url], expect, mode: "doctor" }, probeDeps, ctx))))
    results.push(...(await isolated("redirect_walk", "T1", ctx, () => checkRedirectWalk({ urls: [url] }, probeDeps, ctx))))
    results.push(...(await isolated("csp_header", "T1", ctx, () => checkCsp({ url, expect }, probeDeps, ctx))))
    if (ids.meta.length > 0) {
      results.push(...(await isolated("meta_domains", "T1", ctx, () => checkMetaDomains({ domains: [host], pixelIds: ids.meta }, probeDeps, ctx))))
    }
  } else {
    results.push(
      checkResult("live_checks", "undetermined", "T1", ctx, {
        reason: "not run: pass --url https://<your production site> to run the live checks (no browser, nothing counted)"
      })
    )
  }

  // The server lane: probed only on request, and only with a linked app.
  const laneInstalled = manifest?.serverLane !== undefined
  if (options.probeServerLane || laneInstalled) {
    results.push(...(await isolated("server_lane_probe", "PV", ctx, () => serverLaneCell(options, deps, ctx, root))))
  }

  const summary = summarizeResults(results)
  return {
    schema: DOCTOR_REPORT_SCHEMA,
    tagVersion: deps.version,
    root,
    appRoot,
    url: options.url,
    ids: { ...ids, source: options.flagIds ? "flags" : "install.json" },
    results,
    summary: { undetermined: summary.undetermined, problem: summary.problem, pass: summary.pass, info: summary.info, total: summary.total },
    exitCode: doctorExitCode(results.map((result) => result.state))
  }
}

async function serverLaneCell(options: DoctorOptions, deps: DoctorDeps, ctx: { runId: null; now(): Date }, root: string): Promise<CheckResult[]> {
  const cell = (state: CheckResult["state"], reason: string) => [checkResult("server_lane_probe", state, "PV", ctx, { reason })]
  if (!options.probeServerLane) {
    return cell("undetermined", "not_probed: the server lane was not probed (pass --probe-server-lane with the Infinite app linked to send one test request)")
  }
  const linked = (deps.linkedApp ?? ((path: string) => defaultLinkedApp(path, deps.env ?? process.env)))(root)
  if (!linked) {
    return cell("undetermined", "not_probed: this repo is not linked to a running Infinite app, so a probe's receipt could not be read; nothing was sent")
  }
  const hex = deps.randomHex ? deps.randomHex() : randomBytes(6).toString("hex")
  const path = serverLaneProbePath(hex)
  const host = new URL(options.url as string).hostname
  const sent = await sendServerLaneProbe(host, path, {
    version: deps.version,
    now: deps.now,
    ...(deps.fetch ? { fetch: deps.fetch } : {})
  })
  if (sent.status === 0) return cell("undetermined", `the probe could not be sent (${sent.detail ?? "network error"})`)
  if (!deps.readServerLaneReceipt) {
    return cell("undetermined", `probe ${path} sent (the site answered HTTP ${sent.status}); its receipt is read in the Infinite app — this is not proof yet`)
  }
  const receipt = await deps.readServerLaneReceipt(path)
  switch (receipt.state) {
    case "verified":
      return cell("pass", `the server lane recorded probe ${path} (receipt from this run)`)
    case "no_receipt":
      return cell("problem", `the server lane never recorded probe ${path}${receipt.reason ? `: ${receipt.reason}` : ""}`)
    default:
      return cell("undetermined", `no receipt yet for probe ${path}${receipt.reason ? ` (${receipt.reason})` : ""}`)
  }
}

const ORDER: Record<CheckResult["state"], number> = { problem: 0, undetermined: 1, info: 2, pass: 3 }

/** The human report. Leads with what could not be told, then problems; never a bare "ok". */
export function renderDoctorText(report: DoctorReport): string {
  const lines: string[] = []
  lines.push(`infinite-tag doctor ${report.tagVersion} — ${report.root}${report.url ? ` · ${report.url}` : ""}`)
  lines.push(`ids from ${report.ids.source}`)
  lines.push(
    `${report.summary.undetermined} could not be determined (did not run or could not tell) · ${report.summary.problem} problem${report.summary.problem === 1 ? "" : "s"} · ${report.summary.pass} passed · ${report.summary.info} worth knowing`
  )
  lines.push("")
  const sorted = [...report.results].sort((a, b) => ORDER[a.state] - ORDER[b.state])
  for (const result of sorted) {
    const where = result.evidence?.[0]
    const at = where ? ("url" in where ? ` ${where.url}` : ` ${where.file}:${where.line}`) : ""
    lines.push(`${result.state.toUpperCase().padEnd(12)} ${result.checkId}${at}`)
    if (result.reason) lines.push(`             ${result.reason}`)
  }
  lines.push("")
  lines.push(`exit ${report.exitCode}`)
  return lines.join("\n")
}
