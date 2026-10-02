// `infinite-tag doctor [--json] [--root <dir>] [--url <https>] [--expect-ga4 G-…]… [--expect-posthog phc_…
// --posthog-api-host …] [--expect-meta <15-16 digits>]… [--probe-server-lane]`: the static + live (T1)
// checks with no browser, for CI and for a quick look. Exit codes (§3d.5): 0 clean · 1 a problem ·
// 3 no problem but something undetermined · 2 usage.
//
// Ids: when ANY --expect-* flag is given the flags are the whole expectation; otherwise the `ids` block
// of `.infinite/install.json`. Never a default.
import { validateGa4MeasurementId, validatePosthogProjectKey } from "../providers/validate.js"
import { INSTRUMENT_VERSION } from "../package-manager.js"
import { DOCTOR_EXIT_CODES } from "../wizard/contracts/codes.js"

import { DOCTOR_REPORT_SCHEMA, DoctorUsageError, renderDoctorText, runDoctor, type DoctorDeps, type DoctorIds, type DoctorOptions } from "./run.js"

export const DOCTOR_USAGE = [
  "Usage: infinite-tag doctor [--json] [--root <dir>] [--url <https://your-site>]",
  "                           [--expect-ga4 G-…]… [--expect-posthog phc_… --posthog-api-host <host or /path>]",
  "                           [--expect-meta <15-16 digit pixel id>]… [--probe-server-lane]",
  "",
  "Checks the installed analytics: the setup checks over your source, and with --url the live checks",
  "(the tags and ids your pages serve, the PostHog proxy, redirects keeping campaign tags, the security",
  "policy, Meta's domain permissions). No browser; every live request is marked as a check, so nothing",
  "is counted as a visit. Ids come from the flags, or from .infinite/install.json.",
  "--probe-server-lane sends ONE test request to the server lane; it needs this repo linked to the",
  "Infinite app (it lands one bot-flagged row in your Infinite data).",
  "",
  "Exit: 0 clean · 1 a problem · 3 no problem but something could not be determined · 2 usage."
].join("\n")

export interface ParsedDoctorArgs {
  help: boolean
  json: boolean
  options: DoctorOptions
}

function value(argv: readonly string[], index: number, flag: string): string {
  const next = argv[index + 1]
  if (next === undefined || next.startsWith("--")) throw new DoctorUsageError(`Missing value for ${flag}.`)
  return next
}

export function parseDoctorArgs(argv: readonly string[], cwd: string): ParsedDoctorArgs {
  let json = false
  let help = false
  let root = cwd
  let url: string | null = null
  let probeServerLane = false
  const ga4: string[] = []
  const meta: string[] = []
  let posthogKey: string | null = null
  let posthogApiHost: string | null = null
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    switch (token) {
      case "--json":
        json = true
        break
      case "--help":
      case "-h":
        help = true
        break
      case "--root":
        root = value(argv, index, token)
        index += 1
        break
      case "--url":
        url = value(argv, index, token)
        index += 1
        break
      case "--expect-ga4":
        ga4.push(value(argv, index, token))
        index += 1
        break
      case "--expect-meta":
        meta.push(value(argv, index, token))
        index += 1
        break
      case "--expect-posthog":
        posthogKey = value(argv, index, token)
        index += 1
        break
      case "--posthog-api-host":
        posthogApiHost = value(argv, index, token)
        index += 1
        break
      case "--probe-server-lane":
        probeServerLane = true
        break
      default:
        throw new DoctorUsageError(`Unknown option for doctor: ${token}`)
    }
  }
  if (url !== null) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new DoctorUsageError(`--url ${JSON.stringify(url)} is not a URL.`)
    }
    if (parsed.protocol !== "https:") throw new DoctorUsageError("--url must be https://.")
  }
  for (const id of ga4) {
    const error = validateGa4MeasurementId(id)
    if (error) throw new DoctorUsageError(error)
  }
  for (const id of meta) {
    if (!/^[0-9]{15,16}$/.test(id)) throw new DoctorUsageError(`--expect-meta ${JSON.stringify(id)} is not a Meta pixel id (15 or 16 digits).`)
  }
  if (posthogKey !== null) {
    const error = validatePosthogProjectKey(posthogKey)
    if (error) throw new DoctorUsageError(error)
    if (posthogApiHost === null) throw new DoctorUsageError("--expect-posthog needs --posthog-api-host (the api_host your site uses, e.g. /ingest or https://eu.i.posthog.com).")
  }
  if (posthogApiHost !== null) {
    if (posthogKey === null) throw new DoctorUsageError("--posthog-api-host needs --expect-posthog.")
    const relative = posthogApiHost.startsWith("/") && !posthogApiHost.startsWith("//")
    if (!relative && !/^https:\/\/[^/]+/.test(posthogApiHost)) throw new DoctorUsageError("--posthog-api-host must be a path like /ingest or an https:// host.")
  }
  const anyFlag = ga4.length > 0 || meta.length > 0 || posthogKey !== null
  const flagIds: DoctorIds | null = anyFlag
    ? {
        ga4,
        meta,
        posthog: posthogKey !== null && posthogApiHost !== null ? { projectKey: posthogKey, apiHost: posthogApiHost } : null,
        infinite: null
      }
    : null
  return { help, json, options: { root, url, flagIds, probeServerLane } }
}

/** The CLI entry (`ios:…/src/cli.ts` routes `doctor …` here). */
export async function runDoctorCommand(argv: readonly string[], deps: Partial<DoctorDeps> = {}): Promise<number> {
  let parsed: ParsedDoctorArgs
  try {
    parsed = parseDoctorArgs(argv, process.cwd())
  } catch (error) {
    return usage(error, argv.includes("--json"))
  }
  if (parsed.help) {
    console.log(DOCTOR_USAGE)
    return 0
  }
  try {
    const report = await runDoctor(parsed.options, {
      version: INSTRUMENT_VERSION,
      now: () => new Date(),
      env: process.env,
      ...deps
    })
    console.log(parsed.json ? JSON.stringify(report, null, 2) : renderDoctorText(report))
    return report.exitCode
  } catch (error) {
    if (error instanceof DoctorUsageError || (error instanceof Error && /install\.json/.test(error.message))) return usage(error, parsed.json)
    throw error
  }
}

function usage(error: unknown, json: boolean): number {
  const message = error instanceof Error ? error.message : String(error)
  if (json) {
    console.log(JSON.stringify({ schema: DOCTOR_REPORT_SCHEMA, error: { code: "usage", message }, exitCode: DOCTOR_EXIT_CODES.usage }))
  } else {
    console.error(message)
    console.error("")
    console.error(DOCTOR_USAGE)
  }
  return DOCTOR_EXIT_CODES.usage
}
