// Env targets (lane O9). Incident guarded: "the sandbox held the real pixel" (2026-09-21/22) — the
// production Meta settings on a Preview / Development environment.
import { describe, expect, it } from "vitest"

import { FIXED_NOW } from "../../../test/wizard/fixture-fetch.js"
import type { EnvTarget, TagHosting } from "../../wizard/contracts/bridge.js"
import type { EnvSourcedId } from "../../wizard/contracts/jobs.js"

import { checkEnvTargets } from "./env-targets.js"

const ctx = { runId: "run-1", now: FIXED_NOW }
const META_ENV: EnvSourcedId = { tool: "meta", envName: "NEXT_PUBLIC_META_PIXEL_ID", file: "app/layout.tsx", line: 12 }

function vercel(envTargets?: Record<string, EnvTarget[]>): TagHosting {
  return {
    provider: "vercel",
    vercel: {
      projectRef: "prj_x",
      projectName: "acme",
      productionBranch: "main",
      rootDirectory: null,
      framework: "nextjs",
      productionDomains: ["acme.com"],
      productionAliases: ["acme.vercel.app"],
      envWriteGranted: true,
      previewProtection: "none",
      ...(envTargets ? { envTargets } : {})
    }
  }
}

describe("env targets", () => {
  it("a Meta pixel id on Production + Preview is a problem", () => {
    const results = checkEnvTargets([META_ENV], vercel({ NEXT_PUBLIC_META_PIXEL_ID: ["production", "preview"] }), ctx)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ checkId: "env_targets", state: "problem", evidence: [{ file: "app/layout.tsx", line: 12 }] })
    expect(results[0]!.reason).toContain("set on Preview as well as Production")
  })

  it("Production only passes (the negative)", () => {
    expect(checkEnvTargets([META_ENV], vercel({ NEXT_PUBLIC_META_PIXEL_ID: ["production"] }), ctx)[0]!.state).toBe("pass")
  })

  it("not Vercel, or no presence read, is undetermined (never pass)", () => {
    expect(checkEnvTargets([META_ENV], { provider: "none", vercel: null }, ctx)[0]!.reason).toContain("not_vercel")
    expect(checkEnvTargets([META_ENV], vercel(), ctx)[0]!.state).toBe("undetermined")
  })
})
