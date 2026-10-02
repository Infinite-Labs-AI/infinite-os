// Install infinite-tag into a copy of a test fixture and return what it wrote (test helper only).
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
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
  warnings: string[]
  read(relativePath: string): string
  exists(relativePath: string): boolean
}

/** Edits a fresh fixture copy before planning (e.g. paste an existing snippet so a tool is ADOPTED). */
export type FixtureMutation = (root: string) => void

function copyFixture(fixture: string, label: string, mutate?: FixtureMutation): string {
  const temp = mkdtempSync(join(tmpdir(), `instrument-site-code-${label}${fixture}-`))
  roots.push(temp)
  const root = join(temp, fixture)
  cpSync(join(fixturesRoot, fixture), root, { recursive: true })
  mutate?.(root)
  return root
}

export function installFixture(fixture: string, artifacts: WorkspaceInstallArtifacts, mutate?: FixtureMutation): InstalledFixture {
  const root = copyFixture(fixture, "", mutate)
  const plan = planInstallation({ root, workspaceId: "ws_test", artifacts })
  if (plan.blockers.length > 0) throw new Error(`Plan blocked: ${plan.blockers.join("; ")}`)
  const result = applyInstallation({ root, workspaceId: "ws_test", plan, allowDirty: true })
  return {
    root,
    plan,
    warnings: result.warnings,
    read: (relativePath) => readFileSync(join(root, relativePath), "utf8"),
    exists: (relativePath) => existsSync(join(root, relativePath))
  }
}

/** Re-plan and re-apply an installed fixture with new artifacts (a re-run of the installer). */
export function reinstallFixture(installed: InstalledFixture, artifacts: WorkspaceInstallArtifacts): InstalledFixture {
  const plan = planInstallation({ root: installed.root, workspaceId: "ws_test", artifacts })
  if (plan.blockers.length > 0) throw new Error(`Plan blocked: ${plan.blockers.join("; ")}`)
  const result = applyInstallation({ root: installed.root, workspaceId: "ws_test", plan, allowDirty: true })
  return { ...installed, plan, warnings: result.warnings }
}

/** Plan only (no write), for blocker assertions. */
export function planFixture(fixture: string, artifacts: WorkspaceInstallArtifacts, mutate?: FixtureMutation): InstallPlan {
  const root = copyFixture(fixture, "plan-", mutate)
  return planInstallation({ root, workspaceId: "ws_test", artifacts })
}

export function cleanupFixtures(): void {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
}
