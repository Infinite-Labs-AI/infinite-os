// Lane O9's checks, registered on lane O6's `CheckRunner` through the `register(checkId, fn)` seam
// (§2.0, §3e.7). This file is the ONE place that names the ids and the input each id takes, so the
// runner's typed methods (`liveBytes`, `redirectWalk`, `csp`, `metaDomains`, `envTargets`, `turnGate`,
// `setupChecks`) can route to them — see `O9_RUNNER_METHODS`.
//
// Every registered function is isolated: a throw becomes `undetermined (test error)`, never a pass and
// never a crash that hides the other checks. The ONE exception is the post-turn gate: a gate that crashed
// checked nothing, and O3's fence acts on `problem` only, so a crash there is a `problem` (the whole turn
// is reverted) — failing open would let an unchecked turn reach the build and T0.
//
// O3 calls the job-level static checks as `run(checkId, {item, root, appRoot, runId})`. So every input
// these functions need beyond that is derived here, never assumed:
//   • the PostHog config BEFORE the job (`posthog_config`'s privacy drift) is read at the base commit
//     (`git show HEAD:<file>`), or given as `before`; when it cannot be read the drift verdict is
//     `undetermined`, never a pass;
//   • the production hosts (`adopted_init_guarded`'s "guard silences production") come from the input
//     or the run (`deps.run()`); unknown → a found guard is `undetermined`, never a pass;
//   • with an `item`, a job-level check grades only the item's files (`allow.files`, `allow.create`,
//     the trigger's evidence) and the item's own finding — never an unrelated finding elsewhere.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { isAbsolute, join, normalize, relative, resolve } from "node:path"

import { checkClickIdCapture } from "../setup-checks/click-id-capture.js"
import { checkMetaAutoConfigOptOut } from "../providers/meta-browser/autoconfig.js"
import { checkHostGuard, readAdoptedInitGuards } from "../setup-checks/host-guard.js"
import { readAppSources, setupChecksOver, type SetupChecksContext } from "../setup-checks/index.js"
import { checkMetaEventId } from "../setup-checks/meta-event-id.js"
import { checkPosthogConfig, posthogConfigDrift, readPosthogConfigs, type PosthogConfigRead } from "../setup-checks/posthog-config.js"
import type { SetupFinding } from "../setup-checks/types.js"
import type { TagHosting } from "../wizard/contracts/bridge.js"
import type { ChecklistItem, CheckContext, CheckFn, CheckResult, CheckRunner, EnvSourcedId, TurnDiff } from "../wizard/contracts/jobs.js"
import type { TestExpect } from "../wizard/contracts/test-engine.js"

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
  /** O6's `CHECK_RUNNER_SEAMS.csp`: `csp(url)` → `{url}`; the expectation comes from the run. */
  csp: "csp",
  /** The job table's fine-grained id (job 12's T1 check, finish-line `t1.csp`); same function. */
  cspHeader: "csp_header",
  metaDomains: "meta_domains",
  envTargets: "env_targets",
  turnGate: "turn_gate",
  setupChecks: "setup_checks",
  posthogConfig: "posthog_config",
  adoptedInitGuarded: "adopted_init_guarded",
  metaEventIdFromHelper: "meta_event_id_from_helper",
  noFbqStandardOnClick: "no_fbq_standard_on_click",
  clickIdCapture: "click_id_capture",
  /** LF4-P1-2: the autoConfig job's own check (automatic events off before the adopted pixel's init). */
  metaAutoconfigOff: "meta_autoconfig_off",
  setupRerunClean: "setup_rerun_clean"
} as const
export type O9CheckId = (typeof O9_CHECK_IDS)[keyof typeof O9_CHECK_IDS]

/** How O6's typed `CheckRunner` methods map onto the registered ids (I1 wires these). */
export const O9_RUNNER_METHODS = {
  liveBytes: { checkId: O9_CHECK_IDS.liveBytes, input: "(urls, expect) → {urls, expect}" },
  redirectWalk: { checkId: O9_CHECK_IDS.redirectWalk, input: "(urls) → {urls}" },
  csp: { checkId: O9_CHECK_IDS.csp, input: "(url) → {url}; expect from the input, else deps.run().expect" },
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
  csp: { url: string; expect?: TestExpect; observedPosthogApiHost?: string }
  csp_header: { url: string; expect?: TestExpect; observedPosthogApiHost?: string }
  meta_domains: MetaDomainsInput
  env_targets: { envSourcedIds: readonly EnvSourcedId[]; hosting: TagHosting }
  turn_gate: { diff: TurnDiff; connectionIds: readonly string[] }
  setup_checks: { appRoot: string; context?: SetupChecksContext }
  posthog_config: JobInput & { before?: readonly PosthogConfigRead[]; sensitivePagesApproved?: boolean; expectedApiHost?: string }
  adopted_init_guarded: JobInput & { productionHosts?: readonly string[] }
  meta_event_id_from_helper: JobInput
  no_fbq_standard_on_click: JobInput
  click_id_capture: JobInput
  meta_autoconfig_off: JobInput
  setup_rerun_clean: JobInput & { context?: SetupChecksContext }
}

/** What O3 passes a job-level check: `{item, root, appRoot, runId}` (item and root optional elsewhere). */
export interface JobInput {
  appRoot: string
  root?: string
  item?: Pick<ChecklistItem, "id" | "allow" | "trigger">
  runId?: string | null
}

/** What the run knows that a check's input does not carry (I1 wires it from the keys verb and the plan). */
export interface O9RunContext {
  /** The exempt production hosts (site source ∪ hosting domains + aliases ∪ the observed host). */
  productionHosts?: readonly string[]
  /** The approved preview guard's exact emitted bytes for job 7. */
  expectedEmittedGuard?: string
  /** The run's expectation (the connection ids), for `csp(url)`. */
  expect?: TestExpect
}

export interface O9CheckDeps extends LiveProbeDeps {
  /** The repo root: relative app roots resolve against it, and the turn gate reads new file contents under it. */
  root?: string
  /** The current run's context; absent → those verdicts are undetermined, never pass. */
  run?: () => O9RunContext | undefined
  /**
   * A file as it was at the base commit, app-root relative: its text, `null` when it did not exist there,
   * `undefined` when the base cannot be read. Default: `git show HEAD:./<file>` in the app root.
   */
  readBaseFile?: (appRoot: string, file: string) => string | null | undefined
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

/** `git show HEAD:./<file>` in the app root; `undefined` when there is no repo or no HEAD. */
export function gitBaseFile(appRoot: string, file: string): string | null | undefined {
  const git = (args: string[]) => execFileSync("git", ["-C", appRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 })
  try {
    git(["rev-parse", "--verify", "--quiet", "HEAD"])
  } catch {
    return undefined
  }
  try {
    return git(["show", `HEAD:./${file}`])
  } catch {
    return null
  }
}

/**
 * The item's scope: its files (`allow.files`, `allow.create`, the trigger's file evidence, compared both
 * repo-relative and app-relative) and its own finding code. `null` when the input carries no item.
 */
function itemScope(input: Record<string, unknown>, appRoot: string, root: string | undefined): ((finding: { file?: string; code?: string }) => boolean) | null {
  const item = input.item as JobInput["item"] | undefined
  if (!item || typeof item !== "object") return null
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [])
  const evidence = Array.isArray(item.trigger?.evidence) ? item.trigger.evidence : []
  const files = new Set(
    [...strings(item.allow?.files), ...strings(item.allow?.create), ...evidence.flatMap((entry) => ("file" in entry && typeof entry.file === "string" ? [entry.file] : []))].map(
      (file) => normalize(file)
    )
  )
  const code = typeof item.trigger?.finding === "string" ? item.trigger.finding : null
  const base = root ?? (typeof input.root === "string" ? input.root : undefined)
  return (finding) => {
    if (code !== null && finding.code === code) return true
    if (!finding.file) return false
    const appRelative = normalize(finding.file)
    const repoRelative = base ? normalize(relative(base, join(appRoot, finding.file))) : appRelative
    return files.has(appRelative) || files.has(repoRelative)
  }
}

/** The tool an item targets, from its id (`preview_guard:ga4` → GA4), or null. */
function itemTool(input: Record<string, unknown>): "GA4" | "PostHog" | "Meta pixel" | null {
  const id = (input.item as { id?: unknown } | undefined)?.id
  if (typeof id !== "string") return null
  const target = id.slice(id.indexOf(":") + 1).toLowerCase()
  if (/\bga4\b|google/.test(target)) return "GA4"
  if (/posthog/.test(target)) return "PostHog"
  if (/meta|pixel|fbq/.test(target)) return "Meta pixel"
  return null
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
  const rootOf = (input: Record<string, unknown>) => deps.root ?? (typeof input.root === "string" ? input.root : undefined)
  /** Findings narrowed to the item's scope (all of them when the input has no item). */
  const scoped = <T extends { file?: string; code?: string }>(input: Record<string, unknown>, findings: readonly T[]): T[] => {
    const inScope = itemScope(input, appRootOf(input, deps), rootOf(input))
    return inScope ? findings.filter(inScope) : [...findings]
  }
  const onlyCodes = (
    input: Record<string, unknown>,
    results: SetupFinding[],
    ctx: CheckContext,
    checkId: string,
    codes: readonly string[],
    cleanReason: string
  ): CheckResult[] => {
    const hits = scoped(
      input,
      results.filter((finding) => codes.includes(finding.code))
    )
    return hits.length > 0
      ? hits.map((finding) => setupFindingResult(finding, ctx, checkId))
      : [checkResult(checkId, "pass", "S", ctx, { reason: cleanReason })]
  }
  const runCsp = (checkId: "csp" | "csp_header") =>
    wrap(checkId, "T1", async (input, ctx) => {
      if (typeof input.url !== "string" || input.url.length === 0) throw new TypeError("url is required")
      const expect = (input.expect as TestExpect | undefined) ?? deps.run?.()?.expect
      if (!expect) {
        return [
          checkResult(checkId, "undetermined", "T1", ctx, {
            reason: "no expectation: the run's connection ids were not available, so the policy was not checked against anything",
            evidence: [{ url: input.url }]
          })
        ]
      }
      const cspInput: CspInput = { url: input.url, expect, ...(typeof input.observedPosthogApiHost === "string" ? { observedPosthogApiHost: input.observedPosthogApiHost } : {}) }
      return (await checkCsp(cspInput, deps, ctx)).map((result) => ({ ...result, checkId }))
    })

  return {
    live_bytes: wrap("live_bytes", "T1", (input, ctx) => checkLiveBytes(input as unknown as LiveBytesInput, deps, ctx)),
    posthog_proxy: wrap("posthog_proxy", "T1", (input, ctx) => checkPosthogProxy(input as unknown as PosthogProxyInput, deps, ctx)),
    redirect_walk: wrap("redirect_walk", "T1", (input, ctx) => checkRedirectWalk(input as unknown as RedirectWalkInput, deps, ctx)),
    csp: runCsp("csp"),
    csp_header: runCsp("csp_header"),
    meta_domains: wrap("meta_domains", "T1", (input, ctx) => checkMetaDomains(input as unknown as MetaDomainsInput, deps, ctx)),
    env_targets: wrap("env_targets", "T1", (input, ctx) =>
      checkEnvTargets(input.envSourcedIds as EnvSourcedId[], input.hosting as TagHosting, ctx)
    ),
    // Fails CLOSED: a gate that crashed checked nothing, so the turn is a problem (O3 reverts it).
    turn_gate: async (input, ctx) => {
      try {
        const given = object(input)
        const reader = repoFileReader(deps.root)
        return turnGate(given.diff as TurnDiff, { connectionIds: (given.connectionIds as string[]) ?? [], ...(reader ? { readFile: reader } : {}) }, ctx)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return [
          checkResult("turn_gate", "problem", "S", ctx, {
            reason: `gate_error: the post-turn gate could not check this turn (${detail.slice(0, 200)}), so the turn is not kept`
          })
        ]
      }
    },
    setup_checks: wrap("setup_checks", "S", (input, ctx) =>
      setupChecksOver(filesOf(input), (input.context as SetupChecksContext | undefined) ?? {}).findings.map((finding) => setupFindingResult(finding, ctx))
    ),
    posthog_config: wrap("posthog_config", "S", (input, ctx) => {
      const appRoot = appRootOf(input, deps)
      const files = filesOf(input)
      const after = readPosthogConfigs(files)
      const findings = scoped(input, checkPosthogConfig({ files, ...(typeof input.expectedApiHost === "string" ? { expectedApiHost: input.expectedApiHost } : {}) }).findings)
      // The config BEFORE the job: given, or read at the base commit for every file that inits PostHog now.
      let before: PosthogConfigRead[] | null = Array.isArray(input.before) ? (input.before as PosthogConfigRead[]) : null
      if (before === null) {
        const readBase = deps.readBaseFile ?? gitBaseFile
        const baseFiles = new Map<string, string>()
        let unreadable = false
        for (const file of new Set(after.filter((read) => !read.managed).map((read) => read.file))) {
          const text = readBase(appRoot, file)
          if (text === undefined) unreadable = true
          else if (text !== null) baseFiles.set(file, text)
        }
        before = unreadable ? null : readPosthogConfigs(baseFiles)
      }
      const results: CheckResult[] = []
      if (before === null) {
        results.push(
          checkResult("posthog_config", "undetermined", "S", ctx, {
            reason: "the PostHog config before this job could not be read (no base commit), so whether autocapture or session replay changed is unknown"
          })
        )
      }
      const drift = before === null ? [] : scoped(input, posthogConfigDrift(before, after, { sensitivePagesApproved: input.sensitivePagesApproved === true }))
      results.push(...[...drift, ...findings].map((finding) => setupFindingResult(finding, ctx, "posthog_config")))
      return results.length > 0 ? results : [checkResult("posthog_config", "pass", "S", ctx, { reason: "the site's PostHog config reads cleanly and its privacy settings are unchanged" })]
    }),
    adopted_init_guarded: wrap("adopted_init_guarded", "S", (input, ctx) => {
      const files = filesOf(input)
      const run = deps.run?.()
      const productionHosts = Array.isArray(input.productionHosts) ? (input.productionHosts as string[]) : run?.productionHosts
      const expectedEmittedGuard = run?.expectedEmittedGuard
      const tool = itemTool(input)
      const toolAt = new Map(readAdoptedInitGuards(files).map((read) => [`${read.file}:${read.line}`, read.tool]))
      const findings = scoped(
        input,
        checkHostGuard({ files, strict: true, ...(productionHosts ? { productionHosts } : {}), ...(expectedEmittedGuard ? { expectedEmittedGuard } : {}) }).findings.filter(
          (finding) => tool === null || toolAt.get(`${finding.file}:${finding.line}`) === tool
        )
      )
      if (findings.length === 0) {
        return [checkResult("adopted_init_guarded", "info", "S", ctx, { reason: "no adopted GA4, PostHog or Meta init was found to guard" })]
      }
      return findings.map((finding) =>
        // Without the production hosts a found guard cannot be shown NOT to silence production (decision 3).
        finding.state === "ok" && !productionHosts
          ? checkResult("adopted_init_guarded", "undetermined", "S", ctx, {
              reason: `${finding.code}: a guard is there, but the production hosts are unknown, so whether it silences production could not be checked`,
              ...(finding.file ? { evidence: [{ file: finding.file, line: finding.line ?? 1 }] } : {})
            })
          : setupFindingResult(finding, ctx, "adopted_init_guarded")
      )
    }),
    meta_event_id_from_helper: wrap("meta_event_id_from_helper", "S", (input, ctx) =>
      onlyCodes(
        input,
        checkMetaEventId({ files: filesOf(input) }).findings,
        ctx,
        "meta_event_id_from_helper",
        ["INF_SETUP_META_EVENT_ID_PAGE_BUILT", "INF_SETUP_META_EVENT_ID_UNDETERMINED"],
        "every Meta event id in page code comes from the server's metaEventId"
      )
    ),
    no_fbq_standard_on_click: wrap("no_fbq_standard_on_click", "S", (input, ctx) =>
      onlyCodes(
        input,
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
    // LF4-P1-2: the autoConfig job is checked on ITS work: in the job's own files, every adopted pixel initialised
    // there queues `fbq('set','autoConfig',false,id)` before its init. The job's other checks (the mirror's event id)
    // pass on a page with nothing of it in it, so they could never tick it.
    meta_autoconfig_off: wrap("meta_autoconfig_off", "S", (input, ctx) => {
      const sources = filesOf(input)
      const inScope = itemScope(input, appRootOf(input, deps), rootOf(input))
      const verdicts: Array<{ file: string; line: number; pixelId: string; reason: string; state: string }> = []
      for (const [file, text] of sources) {
        if (inScope && !inScope({ file })) continue
        const init = /fbq\s*\(\s*["']init["']\s*,\s*["']([0-9]+)["']/g
        for (let match = init.exec(text); match !== null; match = init.exec(text)) {
          const verdict = checkMetaAutoConfigOptOut(text, match[1]!, "adopted")
          verdicts.push({ file, line: text.slice(0, match.index).split("\n").length, pixelId: match[1]!, reason: verdict.reason, state: verdict.state })
        }
      }
      if (verdicts.length === 0) {
        return [checkResult("meta_autoconfig_off", "undetermined", "S", ctx, { reason: "no literal fbq('init', '<id>') in the job's files, so the opt-out cannot be read" })]
      }
      const off = verdicts.filter((verdict) => verdict.reason === "opted_out_before_init")
      const wrong = verdicts.filter((verdict) => ["opt_out_missing", "opted_in", "opt_out_after_init", "opt_out_commented"].includes(verdict.reason))
      if (wrong.length > 0) {
        return wrong.map((verdict) => ({
          ...checkResult("meta_autoconfig_off", "problem", "S", ctx, {
            reason: `automatic events on pixel ${verdict.pixelId}: ${verdict.reason}`,
            evidence: [{ file: verdict.file, line: verdict.line }]
          }),
          // LF4 close round 2 (P2-2): no opt-out at all is the job's change MISSING (an opt-in or a late one is wrong).
          ...(verdict.reason === "opt_out_missing" ? { absent: true as const } : {})
        }))
      }
      if (off.length === verdicts.length) {
        return [checkResult("meta_autoconfig_off", "pass", "S", ctx, { reason: `autoConfig is off before init for ${[...new Set(off.map((verdict) => verdict.pixelId))].join(", ")}` })]
      }
      const unread = verdicts.find((verdict) => verdict.reason !== "opted_out_before_init")!
      return [checkResult("meta_autoconfig_off", "undetermined", "S", ctx, { reason: `automatic events on pixel ${unread.pixelId}: ${unread.reason}` })]
    }),
    setup_rerun_clean: wrap("setup_rerun_clean", "S", (input, ctx) => {
      const report = setupChecksOver(filesOf(input), (input.context as SetupChecksContext | undefined) ?? {})
      const findings = scoped(input, report.findings)
      const problems = findings.filter((finding) => finding.state === "problem")
      const undetermined = findings.filter((finding) => finding.state === "undetermined")
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
