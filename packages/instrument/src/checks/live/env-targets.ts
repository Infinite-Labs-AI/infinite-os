// `env_targets`: is a provider id that the site reads from an env var set ONLY for Production?
//
// Incident guarded (PORT-PLAN §4, "the sandbox held the real pixel", 2026-09-21/22): the production
// Meta pixel / CAPI settings sat on a Preview / Development environment, so preview deploys sent real
// events into the production pixel. On infinite.fast the FIRST of the three Meta preview layers is
// exactly this: `INFINITE_META_PIXEL_ID` is set for Vercel Production only (port plan row 1).
//
// Inputs (no values ever): lane O6's census `envSourcedIds` (which env var feeds which provider id, at
// which file:line) and the hosting verb's env-target PRESENCE read (§3b `hosting?envNames=`:
// `envTargets: {<name>: ["production"|"preview"|"development"]}`). The rule applies to every provider:
//   • set on Preview or Development → problem (previews send to the real tool);
//   • set on no target at all → problem (the production build has no id; the tool never boots);
//   • Production only → pass;
//   • not Vercel, or the presence read is missing → undetermined (never pass).
import type { TagHosting } from "../../wizard/contracts/bridge.js"
import type { CheckContext, CheckResult, EnvSourcedId } from "../../wizard/contracts/jobs.js"
import { checkResult } from "../result.js"

export const ENV_TARGETS_CHECK_ID = "env_targets" as const

/** The hosting verb's `envNames` rule (§3b / C4): ≤10 names, each a public build-time name. */
export const ENV_NAME_PATTERN = /^(NEXT_PUBLIC|VITE|PUBLIC)_[A-Z0-9_]{1,64}$/
export const MAX_ENV_NAMES = 10

/** The names to ask the hosting verb about (`?envNames=`), valid and de-duplicated, at most 10. */
export function envNamesFor(envSourcedIds: readonly EnvSourcedId[]): string[] {
  return [...new Set(envSourcedIds.map((entry) => entry.envName))].filter((name) => ENV_NAME_PATTERN.test(name)).slice(0, MAX_ENV_NAMES)
}

const TOOL_LABEL: Record<EnvSourcedId["tool"], string> = {
  ga4: "GA4",
  posthog: "PostHog",
  meta: "Meta pixel",
  infinite: "Infinite"
}

export function checkEnvTargets(
  envSourcedIds: readonly EnvSourcedId[],
  hosting: TagHosting,
  ctx: Pick<CheckContext, "runId" | "now">
): CheckResult[] {
  if (envSourcedIds.length === 0) {
    return [checkResult(ENV_TARGETS_CHECK_ID, "info", "T1", ctx, { reason: "no provider id is read from an env var, so no env target can leak it" })]
  }
  const asked = new Set(envNamesFor(envSourcedIds))
  const byName = new Map<string, EnvSourcedId[]>()
  for (const entry of envSourcedIds) byName.set(entry.envName, [...(byName.get(entry.envName) ?? []), entry])

  const results: CheckResult[] = []
  for (const [envName, entries] of byName) {
    const evidence = entries.map((entry) => ({ file: entry.file, line: entry.line }))
    const tools = [...new Set(entries.map((entry) => TOOL_LABEL[entry.tool]))].join(" and ")
    const result = (state: CheckResult["state"], reason: string) =>
      results.push(checkResult(ENV_TARGETS_CHECK_ID, state, "T1", ctx, { reason, evidence }))

    if (hosting.provider !== "vercel" || hosting.vercel === null) {
      result("undetermined", `not_vercel: ${envName} (${tools}) is read from an env var, and only Vercel's env targets can be read`)
      continue
    }
    if (!asked.has(envName)) {
      result("undetermined", `${envName} is not a public build-time name (or past the ${MAX_ENV_NAMES}-name limit), so its targets were not read`)
      continue
    }
    const targets = hosting.vercel.envTargets?.[envName]
    if (targets === undefined) {
      result("undetermined", `the hosting read did not include ${envName}'s env targets`)
      continue
    }
    const leaking = targets.filter((target) => target !== "production")
    if (leaking.length > 0) {
      result(
        "problem",
        `${envName} (${tools}) is set on ${leaking.map(capital).join(" and ")}${targets.includes("production") ? " as well as Production" : ""}: preview and development builds send to the real ${tools}. Keep it on Production only`
      )
      continue
    }
    if (targets.length === 0) {
      result("problem", `${envName} (${tools}) is not set on any Vercel environment, so the production build has no id and the tag never boots`)
      continue
    }
    result("pass", `${envName} (${tools}) is set on Production only`)
  }
  return results
}

function capital(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
