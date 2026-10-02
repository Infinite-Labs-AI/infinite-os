// Install infinite-tag into a copy of a test fixture and return what it wrote (test helper only).
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { applyInstallation } from "../../src/apply.js"
import { planInstallation } from "../../src/plan.js"
import type { InstallPlan, WorkspaceInstallArtifacts } from "../../src/types.js"

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "../fixtures")
const roots: string[] = []

export interface InstalledFixture {
  root: string
  plan: InstallPlan
  read(relativePath: string): string
}

export function installFixture(fixture: string, artifacts: WorkspaceInstallArtifacts): InstalledFixture {
  const temp = mkdtempSync(join(tmpdir(), `instrument-site-code-${fixture}-`))
  roots.push(temp)
  const root = join(temp, fixture)
  cpSync(join(fixturesRoot, fixture), root, { recursive: true })
  const plan = planInstallation({ root, workspaceId: "ws_test", artifacts })
  if (plan.blockers.length > 0) throw new Error(`Plan blocked: ${plan.blockers.join("; ")}`)
  applyInstallation({ root, workspaceId: "ws_test", plan, allowDirty: true })
  return { root, plan, read: (relativePath) => readFileSync(join(root, relativePath), "utf8") }
}

/** Plan only (no write), for blocker assertions. */
export function planFixture(fixture: string, artifacts: WorkspaceInstallArtifacts): InstallPlan {
  const temp = mkdtempSync(join(tmpdir(), `instrument-site-code-plan-${fixture}-`))
  roots.push(temp)
  const root = join(temp, fixture)
  cpSync(join(fixturesRoot, fixture), root, { recursive: true })
  return planInstallation({ root, workspaceId: "ws_test", artifacts })
}

export function cleanupFixtures(): void {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
}
