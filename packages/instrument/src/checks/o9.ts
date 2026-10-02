// Lane O9's checks, registered on lane O6's `CheckRunner` through the `register(checkId, fn)` seam
// (§2.0, §3e.7). This file is the ONE place that names the ids and the input each id takes, so the
// runner's typed methods (`liveBytes`, `redirectWalk`, `csp`, `metaDomains`, `envTargets`, `turnGate`,
// `setupChecks`) can route to them — see `O9_RUNNER_METHODS`.
//
// Every registered function is isolated: a throw becomes `undetermined (test error)`, never a pass and
// never a crash that hides the other checks.
import { readFileSync } from "node:fs"
import { isAbsolute, join, normalize, resolve } from "node:path"

import { checkClickIdCapture } from "../setup-checks/click-id-capture.js"
import { checkHostGuard } from "../setup-checks/host-guard.js"
import { readAppSources, setupChecksOver, type SetupChecksContext } from "../setup-checks/index.js"
import { checkMetaEventId } from "../setup-checks/meta-event-id.js"
import { checkPosthogConfig, posthogConfigDrift, readPosthogConfigs, type PosthogConfigRead } from "../setup-checks/posthog-config.js"
import type { SetupFinding } from "../setup-checks/types.js"
import type { TagHosting } from "../wizard/contracts/bridge.js"
import type { CheckContext, CheckFn, CheckResult, CheckRunner, EnvSourcedId, TurnDiff } from "../wizard/contracts/jobs.js"

import { checkCsp, type CspInput } from "./live/csp.js"
import { checkEnvTargets } from "./live/env-targets.js"
import { checkLiveBytes, type LiveBytesInput } from "./live/live-bytes.js"
import { checkMetaDomains, type MetaDomainsInput } from "./live/meta-domains.js"
import type { LiveProbeDeps } from "./live/probe.js"
import { checkPosthogProxy, type PosthogProxyInput } from "./live/proxy.js"
import { checkRedirectWalk, type RedirectWalkInput } from "./live/redirects.js"
import { checkResult, isolated } from "./result.js"
import { turnGate } from "./turn-gate.js"

/** Every id lane O9 registers, and the input `run(id, input)` takes. */
export const O9_CHECK_IDS = {
  liveBytes: "live_bytes",
  posthogProxy: "posthog_proxy",
  redirectWalk: "redirect_walk",
  csp: "csp_header",
  metaDomains: "meta_domains",
  envTargets: "env_targets",
  turnGate: "turn_gate",
  setupChecks: "setup_checks",
  posthogConfig: "posthog_config",
  adoptedInitGuarded: "adopted_init_guarded",
  metaEventIdFromHelper: "meta_event_id_from_helper",
  noFbqStandardOnClick: "no_fbq_standard_on_click",
  clickIdCapture: "click_id_capture",
  setupRerunClean: "setup_rerun_clean"
} as const
export type O9CheckId = (typeof O9_CHECK_IDS)[keyof typeof O9_CHECK_IDS]

/** How O6's typed `CheckRunner` methods map onto the registered ids (I1 wires these). */
export const O9_RUNNER_METHODS = {
  liveBytes: { checkId: O9_CHECK_IDS.liveBytes, input: "(urls, expect) → {urls, expect}" },
  redirectWalk: { checkId: O9_CHECK_IDS.redirectWalk, input: "(urls) → {urls}" },
  csp: { checkId: O9_CHECK_IDS.csp, input: "(url) → {url, expect}" },
  metaDomains: { checkId: O9_CHECK_IDS.metaDomains, input: "(domains, pixelIds) → {domains, pixelIds}" },
  envTargets: { checkId: O9_CHECK_IDS.envTargets, input: "(envSourcedIds, hosting) → {envSourcedIds, hosting}" },
  turnGate: { checkId: O9_CHECK_IDS.turnGate, input: "(diff, {connectionIds}) → {diff, connectionIds}" },
  setupChecks: { checkId: O9_CHECK_IDS.setupChecks, input: "(appRoot) → {appRoot}" }
} as const satisfies Partial<Record<keyof CheckRunner, { checkId: O9CheckId; input: string }>>

/** Inputs, by id. */
export interface O9CheckInputs {
  live_bytes: LiveBytesInput
  posthog_proxy: PosthogProxyInput
  redirect_walk: RedirectWalkInput
  csp_header: CspInput
  meta_domains: MetaDomainsInput
  env_targets: { envSourcedIds: readonly EnvSourcedId[]; hosting: TagHosting }
  turn_gate: { diff: TurnDiff; connectionIds: readonly string[] }
  setup_checks: { appRoot: string; context?: SetupChecksContext }
  posthog_config: { appRoot: string; before?: readonly PosthogConfigRead[]; sensitivePagesApproved?: boolean; expectedApiHost?: string }
  adopted_init_guarded: { appRoot: string; productionHosts?: readonly string[] }
  meta_event_id_from_helper: { appRoot: string }
  no_fbq_standard_on_click: { appRoot: string }
  click_id_capture: { appRoot: string }
  setup_rerun_clean: { appRoot: string; context?: SetupChecksContext }
}

export interface O9CheckDeps extends LiveProbeDeps {
  /** The repo root: relative app roots resolve against it, and the turn gate reads new file contents under it. */
  root?: string
}

/** A setup-check finding as a `CheckResult` (`ok` → `pass`). */
export function setupFindingResult(finding: SetupFinding, ctx: Pick<CheckContext, "runId" | "now">, checkId: string = finding.check): CheckResult {
  return checkResult(checkId, finding.state === "ok" ? "pass" : finding.state, "S", ctx, {
    reason: `${finding.code}: ${finding.message}`,
    ...(finding.file ? { evidence: [{ file: finding.file, line: finding.line ?? 1 }] } : {})
  })
}

function appRootOf(input: { appRoot?: unknown }, deps: O9CheckDeps): string {
  if (typeof input.appRoot !== "string" || input.appRoot.length === 0) throw new TypeError("appRoot is required")
  if (isAbsolute(input.appRoot)) return input.appRoot
  if (!deps.root) throw new TypeError("a relative appRoot needs deps.root")
  return resolve(deps.root, input.appRoot)
}

/** Reads a repo file after the turn for the gate's contextual rules; never outside the root. */
function repoFileReader(root: string | undefined): ((path: string) => string | null) | undefined {
  if (!root) return undefined
  return (path: string) => {
    const clean = normalize(path)
    if (isAbsolute(clean) || clean.startsWith("..")) return null
    try {
      return readFileSync(join(root, clean), "utf8")
    } catch {
      return null
    }
  }
}

function object(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object") throw new TypeError("the check input must be an object")
  return input as Record<string, unknown>
}

/** The functions, by id (exported for tests and for a runner that is not O6's). */
export function o9CheckFunctions(deps: O9CheckDeps): Record<O9CheckId, CheckFn> {
  const wrap =
    (checkId: O9CheckId, tier: CheckResult["tier"], run: (input: Record<string, unknown>, ctx: CheckContext) => Promise<CheckResult[]> | CheckResult[]): CheckFn =>
    (input, ctx) =>
      isolated(checkId, tier, ctx, async () => run(object(input), ctx))

  const filesOf = (input: Record<string, unknown>) => readAppSources(appRootOf(input, deps))
  const onlyCodes = (results: SetupFinding[], ctx: CheckContext, checkId: string, codes: readonly string[], cleanReason: string): CheckResult[] => {
    const hits = results.filter((finding) => codes.includes(finding.code))
    return hits.length > 0
      ? hits.map((finding) => setupFindingResult(finding, ctx, checkId))
      : [checkResult(checkId, "pass", "S", ctx, { reason: cleanReason })]
  }

  return {
    live_bytes: wrap("live_bytes", "T1", (input, ctx) => checkLiveBytes(input as unknown as LiveBytesInput, deps, ctx)),
    posthog_proxy: wrap("posthog_proxy", "T1", (input, ctx) => checkPosthogProxy(input as unknown as PosthogProxyInput, deps, ctx)),
    redirect_walk: wrap("redirect_walk", "T1", (input, ctx) => checkRedirectWalk(input as unknown as RedirectWalkInput, deps, ctx)),
    csp_header: wrap("csp_header", "T1", (input, ctx) => checkCsp(input as unknown as CspInput, deps, ctx)),
    meta_domains: wrap("meta_domains", "T1", (input, ctx) => checkMetaDomains(input as unknown as MetaDomainsInput, deps, ctx)),
    env_targets: wrap("env_targets", "T1", (input, ctx) =>
      checkEnvTargets(input.envSourcedIds as EnvSourcedId[], input.hosting as TagHosting, ctx)
    ),
    turn_gate: wrap("turn_gate", "S", (input, ctx) => {
      const reader = repoFileReader(deps.root)
      return turnGate(input.diff as TurnDiff, { connectionIds: (input.connectionIds as string[]) ?? [], ...(reader ? { readFile: reader } : {}) }, ctx)
    }),
    setup_checks: wrap("setup_checks", "S", (input, ctx) =>
      setupChecksOver(filesOf(input), (input.context as SetupChecksContext | undefined) ?? {}).findings.map((finding) => setupFindingResult(finding, ctx))
    ),
    posthog_config: wrap("posthog_config", "S", (input, ctx) => {
      const files = filesOf(input)
      const findings = checkPosthogConfig({ files, ...(typeof input.expectedApiHost === "string" ? { expectedApiHost: input.expectedApiHost } : {}) }).findings
      const drift = Array.isArray(input.before)
        ? posthogConfigDrift(input.before as PosthogConfigRead[], readPosthogConfigs(files), { sensitivePagesApproved: input.sensitivePagesApproved === true })
        : []
      const all = [...drift, ...findings]
      return all.length > 0
        ? all.map((finding) => setupFindingResult(finding, ctx, "posthog_config"))
        : [checkResult("posthog_config", "pass", "S", ctx, { reason: "the site's PostHog config reads cleanly" })]
    }),
    adopted_init_guarded: wrap("adopted_init_guarded", "S", (input, ctx) => {
      const findings = checkHostGuard({
        files: filesOf(input),
        strict: true,
        ...(Array.isArray(input.productionHosts) ? { productionHosts: input.productionHosts as string[] } : {})
      }).findings
      return findings.length > 0
        ? findings.map((finding) => setupFindingResult(finding, ctx, "adopted_init_guarded"))
        : [checkResult("adopted_init_guarded", "info", "S", ctx, { reason: "no adopted GA4, PostHog or Meta init was found to guard" })]
    }),
    meta_event_id_from_helper: wrap("meta_event_id_from_helper", "S", (input, ctx) =>
      onlyCodes(
        checkMetaEventId({ files: filesOf(input) }).findings,
        ctx,
        "meta_event_id_from_helper",
        ["INF_SETUP_META_EVENT_ID_PAGE_BUILT", "INF_SETUP_META_EVENT_ID_UNDETERMINED"],
        "every Meta event id in page code comes from the server's metaEventId"
      )
    ),
    no_fbq_standard_on_click: wrap("no_fbq_standard_on_click", "S", (input, ctx) =>
      onlyCodes(
        checkMetaEventId({ files: filesOf(input) }).findings,
        ctx,
        "no_fbq_standard_on_click",
        ["INF_SETUP_META_STANDARD_ON_CLICK"],
        "no standard Meta conversion fires from a click handler"
      )
    ),
    click_id_capture: wrap("click_id_capture", "S", (input, ctx) =>
      checkClickIdCapture({ files: filesOf(input) }).findings.map((finding) => setupFindingResult(finding, ctx, "click_id_capture"))
    ),
    setup_rerun_clean: wrap("setup_rerun_clean", "S", (input, ctx) => {
      const report = setupChecksOver(filesOf(input), (input.context as SetupChecksContext | undefined) ?? {})
      const problems = report.findings.filter((finding) => finding.state === "problem")
      const undetermined = report.findings.filter((finding) => finding.state === "undetermined")
      if (problems.length > 0) {
        return [
          checkResult("setup_rerun_clean", "problem", "S", ctx, {
            reason: `${problems.length} setup problem${problems.length === 1 ? "" : "s"} remain: ${problems.map((finding) => finding.code).join(", ")}`,
            evidence: problems.filter((finding) => finding.file).map((finding) => ({ file: finding.file as string, line: finding.line ?? 1 }))
          })
        ]
      }
      if (undetermined.length > 0) {
        return [checkResult("setup_rerun_clean", "undetermined", "S", ctx, { reason: `no problem, ${undetermined.length} not determinable from source` })]
      }
      return [checkResult("setup_rerun_clean", "pass", "S", ctx, { reason: "the setup checks re-run clean" })]
    })
  }
}

/** Register every O9 check on a runner (O6's `CheckRunner`, or any `{register}`). */
export function registerO9Checks(runner: Pick<CheckRunner, "register">, deps: O9CheckDeps): void {
  for (const [checkId, fn] of Object.entries(o9CheckFunctions(deps))) runner.register(checkId, fn)
}
