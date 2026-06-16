import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"

import { applyInstallation, snapshotFiles, restoreSnapshot } from "./apply.js"
import { inspectWorkspace } from "./inspect.js"
import { installManifestRelativePath } from "./manifest.js"
import { planInstallation } from "./plan.js"
import { uninstallInstallation } from "./uninstall.js"

const tempRoots: string[] = []
const fixtureRoot = dirname(fileURLToPath(import.meta.url))

function copyFixture(name: string): string {
  const source = join(fixtureRoot, "../test/fixtures", name)
  const targetRoot = mkdtempSync(join(tmpdir(), `instrument-apply-${name}-`))
  const target = join(targetRoot, name)
  tempRoots.push(targetRoot)
  cpSync(source, target, { recursive: true })
  return target
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe("applyInstallation", () => {
  it("refuses unsupported or low-confidence plans", () => {
    const root = copyFixture("unsupported-basic")
    const inspectResult = inspectWorkspace(root)
    const plan = planInstallation({
      root,
      inspect: inspectResult,
      workspaceId: "ws_test",
      artifacts: {
        ga4: {
          measurementId: "G-TEST123"
        }
      }
    })

    expect(() =>
      applyInstallation({
        root,
        workspaceId: "ws_test",
        plan
      })
    ).toThrow(/Refusing to apply/)
  })

  it("injects a managed HTML snippet block once for static fixtures", () => {
    const root = copyFixture("static-html-basic")
    const inspectResult = inspectWorkspace(root)
    const plan = planInstallation({
      root,
      inspect: inspectResult,
      workspaceId: "ws_test",
      artifacts: {
        ga4: {
          measurementId: "G-TEST123"
        },
        posthog: {
          projectKey: "phc_test",
          apiHost: "https://app.posthog.example"
        },
        x: {
          pixelId: "tw-pixel-123",
          eventTagIds: ["tw-event-1"]
        }
      }
    })

    const first = applyInstallation({
      root,
      workspaceId: "ws_test",
      plan
    })

    const htmlPath = join(root, "index.html")
    const firstHtml = readFileSync(htmlPath, "utf8")
    expect(first.changedFiles).toEqual([
      "index.html",
      installManifestRelativePath
    ])
    expect(firstHtml).toContain("<!-- infinite:start -->")
    expect(firstHtml).toContain("G-TEST123")
    expect(firstHtml).toContain("phc_test")
    expect(firstHtml).toContain("tw-pixel-123")

    const rerunPlan = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: {
        ga4: {
          measurementId: "G-TEST123"
        },
        posthog: {
          projectKey: "phc_test",
          apiHost: "https://app.posthog.example"
        },
        x: {
          pixelId: "tw-pixel-123",
          eventTagIds: ["tw-event-1"]
        }
      }
    })
    const second = applyInstallation({
      root,
      workspaceId: "ws_test",
      plan: rerunPlan
    })
    const secondHtml = readFileSync(htmlPath, "utf8")

    expect(second.changedFiles).toEqual([])
    expect(secondHtml).toBe(firstHtml)
    expect(secondHtml.match(/infinite:start/g)).toHaveLength(1)
  })

  it("creates a managed analytics module and boot call once for Vite React fixtures", () => {
    const root = copyFixture("vite-react-basic")
    const inspectResult = inspectWorkspace(root)
    const plan = planInstallation({
      root,
      inspect: inspectResult,
      workspaceId: "ws_test",
      artifacts: {
        ga4: {
          measurementId: "G-TEST123"
        },
        posthog: {
          projectKey: "phc_test",
          apiHost: "https://app.posthog.example"
        }
      }
    })

    const first = applyInstallation({
      root,
      workspaceId: "ws_test",
      plan
    })

    const mainPath = join(root, "src/main.tsx")
    const analyticsPath = join(root, "src/lib/infinite-analytics.ts")
    const firstMain = readFileSync(mainPath, "utf8")
    const firstAnalytics = readFileSync(analyticsPath, "utf8")

    expect(first.changedFiles).toEqual([
      "src/main.tsx",
      "src/lib/infinite-analytics.ts",
      installManifestRelativePath
    ])
    expect(firstMain).toContain('import { installInfiniteInstrumentation } from "./lib/infinite-analytics"')
    expect(firstMain).toContain("installInfiniteInstrumentation()")
    expect(firstAnalytics).toContain("G-TEST123")
    expect(firstAnalytics).toContain("phc_test")
    expect(firstAnalytics).toContain("https://app.posthog.example")

    const rerunPlan = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: {
        ga4: {
          measurementId: "G-TEST123"
        },
        posthog: {
          projectKey: "phc_test",
          apiHost: "https://app.posthog.example"
        }
      }
    })
    const second = applyInstallation({
      root,
      workspaceId: "ws_test",
      plan: rerunPlan
    })
    const secondMain = readFileSync(mainPath, "utf8")
    const secondAnalytics = readFileSync(analyticsPath, "utf8")

    expect(second.changedFiles).toEqual([])
    expect(secondMain).toBe(firstMain)
    expect(secondAnalytics).toBe(firstAnalytics)
    expect(secondMain.match(/installInfiniteInstrumentation\(\)/g)).toHaveLength(1)

    const manifestPath = join(root, installManifestRelativePath)
    expect(existsSync(manifestPath)).toBe(true)
    expect(existsSync(join(root, ".env"))).toBe(false)
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
      workspaceId: "ws_test",
      framework: "vite-react",
      providers: ["ga4", "posthog"]
    })
  })

  it("creates managed Next app router wiring once for a simple fixture", () => {
    const root = copyFixture("next-app-router-basic")
    const inspectResult = inspectWorkspace(root)
    const plan = planInstallation({
      root,
      inspect: inspectResult,
      workspaceId: "ws_test",
      artifacts: {
        ga4: {
          measurementId: "G-TEST123"
        },
        posthog: {
          projectKey: "phc_test",
          apiHost: "https://app.posthog.example"
        }
      }
    })

    const first = applyInstallation({
      root,
      workspaceId: "ws_test",
      plan
    })

    const layoutPath = join(root, "app/layout.tsx")
    const clientPath = join(root, "lib/infinite-analytics-client.tsx")
    const analyticsPath = join(root, "lib/infinite-analytics.ts")
    const firstLayout = readFileSync(layoutPath, "utf8")
    const firstClient = readFileSync(clientPath, "utf8")
    const firstAnalytics = readFileSync(analyticsPath, "utf8")

    expect(first.changedFiles).toEqual([
      "app/layout.tsx",
      "lib/infinite-analytics-client.tsx",
      "lib/infinite-analytics.ts",
      installManifestRelativePath
    ])
    expect(firstLayout).toContain(
      'import { InfiniteAnalyticsClient } from "../lib/infinite-analytics-client"'
    )
    expect(firstLayout).toContain("<InfiniteAnalyticsClient />")
    expect(firstClient).toContain('"use client"')
    expect(firstClient).toContain("installInfiniteInstrumentation()")
    expect(firstAnalytics).toContain("G-TEST123")
    expect(firstAnalytics).toContain("phc_test")

    const rerunPlan = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: {
        ga4: {
          measurementId: "G-TEST123"
        },
        posthog: {
          projectKey: "phc_test",
          apiHost: "https://app.posthog.example"
        }
      }
    })
    const second = applyInstallation({
      root,
      workspaceId: "ws_test",
      plan: rerunPlan
    })
    const secondLayout = readFileSync(layoutPath, "utf8")
    const secondClient = readFileSync(clientPath, "utf8")
    const secondAnalytics = readFileSync(analyticsPath, "utf8")

    expect(second.changedFiles).toEqual([])
    expect(secondLayout).toBe(firstLayout)
    expect(secondClient).toBe(firstClient)
    expect(secondAnalytics).toBe(firstAnalytics)
    expect(secondLayout.match(/InfiniteAnalyticsClient/g)).toHaveLength(2)
    expect(secondLayout.match(/<InfiniteAnalyticsClient \/>/g)).toHaveLength(1)
  })

  it("creates managed Next pages router wiring once for a simple fixture", () => {
    const root = copyFixture("next-pages-router-basic")
    const inspectResult = inspectWorkspace(root)
    const plan = planInstallation({
      root,
      inspect: inspectResult,
      workspaceId: "ws_test",
      artifacts: {
        ga4: {
          measurementId: "G-TEST123"
        },
        x: {
          pixelId: "tw-pixel-123",
          eventTagIds: ["tw-event-1"]
        }
      }
    })

    const first = applyInstallation({
      root,
      workspaceId: "ws_test",
      plan
    })

    const appPath = join(root, "pages/_app.tsx")
    const clientPath = join(root, "lib/infinite-analytics-client.tsx")
    const analyticsPath = join(root, "lib/infinite-analytics.ts")
    const firstApp = readFileSync(appPath, "utf8")
    const firstClient = readFileSync(clientPath, "utf8")
    const firstAnalytics = readFileSync(analyticsPath, "utf8")

    expect(first.changedFiles).toEqual([
      "pages/_app.tsx",
      "lib/infinite-analytics-client.tsx",
      "lib/infinite-analytics.ts",
      installManifestRelativePath
    ])
    expect(firstApp).toContain(
      'import { InfiniteAnalyticsClient } from "../lib/infinite-analytics-client"'
    )
    expect(firstApp).toContain("<InfiniteAnalyticsClient />")
    expect(firstApp).toContain("<Component {...pageProps} />")
    expect(firstClient).toContain('"use client"')
    expect(firstAnalytics).toContain("G-TEST123")
    expect(firstAnalytics).toContain("tw-pixel-123")

    const rerunPlan = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: {
        ga4: {
          measurementId: "G-TEST123"
        },
        x: {
          pixelId: "tw-pixel-123",
          eventTagIds: ["tw-event-1"]
        }
      }
    })
    const second = applyInstallation({
      root,
      workspaceId: "ws_test",
      plan: rerunPlan
    })
    const secondApp = readFileSync(appPath, "utf8")
    const secondClient = readFileSync(clientPath, "utf8")
    const secondAnalytics = readFileSync(analyticsPath, "utf8")

    expect(second.changedFiles).toEqual([])
    expect(secondApp).toBe(firstApp)
    expect(secondClient).toBe(firstClient)
    expect(secondAnalytics).toBe(firstAnalytics)
    expect(secondApp.match(/InfiniteAnalyticsClient/g)).toHaveLength(2)
    expect(secondApp.match(/<InfiniteAnalyticsClient \/>/g)).toHaveLength(1)
  })

  it("keeps multi-line imports intact in Vite main entrypoints and round-trips uninstall", () => {
    const root = copyFixture("vite-react-basic")
    const mainPath = join(root, "src/main.tsx")
    const multiLineImport = 'import {\n  StrictMode\n} from "react";'
    const originalMain = [
      "import {",
      "  StrictMode",
      '} from "react";',
      'import ReactDOM from "react-dom/client";',
      "",
      "function App(): React.JSX.Element {",
      "  return <h1>Vite fixture</h1>;",
      "}",
      "",
      'const root = document.getElementById("root");',
      "",
      "if (!root) {",
      '  throw new Error("Missing root element");',
      "}",
      "",
      "ReactDOM.createRoot(root).render(",
      "  <StrictMode>",
      "    <App />",
      "  </StrictMode>",
      ");",
      ""
    ].join("\n")
    writeFileSync(mainPath, originalMain)

    const plan = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: {
        ga4: {
          measurementId: "G-TEST123"
        }
      }
    })
    expect(plan.blockers).toEqual([])

    applyInstallation({
      root,
      workspaceId: "ws_test",
      plan
    })

    const appliedMain = readFileSync(mainPath, "utf8")
    // The multi-line import must survive byte-for-byte — nothing spliced inside it.
    expect(appliedMain).toContain(multiLineImport)
    // The managed wiring lands after the complete import section, never inside it.
    expect(appliedMain).toContain(
      'import ReactDOM from "react-dom/client";\n' +
        'import { installInfiniteInstrumentation } from "./lib/infinite-analytics"\n' +
        "\ninstallInfiniteInstrumentation()\n"
    )
    expect(appliedMain.match(/installInfiniteInstrumentation\(\)/g)).toHaveLength(1)

    const uninstalled = uninstallInstallation({ root })
    expect(uninstalled.restoredFiles).toContain("src/main.tsx")
    expect(readFileSync(mainPath, "utf8")).toBe(originalMain)
  })

  it("preserves a leading comment line in Vite main entrypoints", () => {
    const root = copyFixture("vite-react-basic")
    const mainPath = join(root, "src/main.tsx")
    const originalMain = `/* eslint-disable no-console */\n${readFileSync(mainPath, "utf8")}`
    writeFileSync(mainPath, originalMain)

    const plan = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: {
        ga4: {
          measurementId: "G-TEST123"
        }
      }
    })
    expect(plan.blockers).toEqual([])

    applyInstallation({
      root,
      workspaceId: "ws_test",
      plan
    })

    const appliedMain = readFileSync(mainPath, "utf8")
    expect(appliedMain.startsWith("/* eslint-disable no-console */\n")).toBe(true)
    expect(appliedMain).toContain('import React from "react";')
    expect(appliedMain).toContain('import ReactDOM from "react-dom/client";')
    expect(appliedMain).toContain("ReactDOM.createRoot(root).render(<App />);")
    expect(appliedMain.match(/installInfiniteInstrumentation\(\)/g)).toHaveLength(1)

    const uninstalled = uninstallInstallation({ root })
    expect(uninstalled.restoredFiles).toContain("src/main.tsx")
    expect(readFileSync(mainPath, "utf8")).toBe(originalMain)
  })
})

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null"
}

function initGitRepo(root: string): void {
  spawnSync("git", ["init"], { cwd: root, env: gitEnv })
  spawnSync("git", ["add", "-A"], { cwd: root, env: gitEnv })
  spawnSync(
    "git",
    [
      "-c", "user.email=test@example.com",
      "-c", "user.name=Test",
      "commit",
      "-m", "init"
    ],
    { cwd: root, env: gitEnv }
  )
}

describe("applyInstallation git safety", () => {
  const artifacts = {
    ga4: { measurementId: "G-TEST123" }
  }

  it("clean committed tree: inspects as clean and apply succeeds writing the manifest", () => {
    const root = copyFixture("static-html-basic")
    initGitRepo(root)

    const inspectResult = inspectWorkspace(root)
    expect(inspectResult.repoStatus).toBe("clean")

    const plan = planInstallation({ root, inspect: inspectResult, workspaceId: "ws_test", artifacts })
    const result = applyInstallation({ root, workspaceId: "ws_test", plan })

    const manifestPath = join(root, installManifestRelativePath)
    expect(existsSync(manifestPath)).toBe(true)
    expect(result.changedFiles).toContain(installManifestRelativePath)
  })

  it("dirty tree refusal: inspects as dirty and apply throws without allowDirty, no manifest created", () => {
    const root = copyFixture("static-html-basic")
    initGitRepo(root)

    // Add an untracked file to make the tree dirty
    writeFileSync(join(root, "notes.txt"), "scratch notes\n")

    const inspectResult = inspectWorkspace(root)
    expect(inspectResult.repoStatus).toBe("dirty")

    const plan = planInstallation({ root, inspect: inspectResult, workspaceId: "ws_test", artifacts })

    expect(() =>
      applyInstallation({ root, workspaceId: "ws_test", plan })
    ).toThrow("Refusing to apply on a dirty git tree without --allow-dirty.")

    const manifestPath = join(root, installManifestRelativePath)
    expect(existsSync(manifestPath)).toBe(false)
  })

  it("--allow-dirty bypass: dirty tree with allowDirty succeeds and injects instrumentation", () => {
    const root = copyFixture("static-html-basic")
    initGitRepo(root)

    // Add an untracked file to make the tree dirty
    writeFileSync(join(root, "notes.txt"), "scratch notes\n")

    const inspectResult = inspectWorkspace(root)
    expect(inspectResult.repoStatus).toBe("dirty")

    const plan = planInstallation({ root, inspect: inspectResult, workspaceId: "ws_test", artifacts })
    const result = applyInstallation({ root, workspaceId: "ws_test", plan, allowDirty: true })

    const manifestPath = join(root, installManifestRelativePath)
    expect(existsSync(manifestPath)).toBe(true)
    expect(result.changedFiles).toContain(installManifestRelativePath)

    const htmlPath = join(root, "index.html")
    expect(readFileSync(htmlPath, "utf8")).toContain("<!-- infinite:start -->")
  })

  it("sanity: non-git fixture reports not-a-git-repo and apply succeeds (documents why gate never fired in old tests)", () => {
    const root = copyFixture("static-html-basic")
    // No git init — plain temp dir

    const inspectResult = inspectWorkspace(root)
    expect(inspectResult.repoStatus).toBe("not-a-git-repo")

    const plan = planInstallation({ root, inspect: inspectResult, workspaceId: "ws_test", artifacts })
    const result = applyInstallation({ root, workspaceId: "ws_test", plan })

    const manifestPath = join(root, installManifestRelativePath)
    expect(existsSync(manifestPath)).toBe(true)
    expect(result.changedFiles).toContain(installManifestRelativePath)
  })
})

describe("applyInstallation rollback", () => {
  it("restores every touched file when a write fails mid-apply", () => {
    const root = copyFixture("vite-react-basic")

    const decoyContents = "// Managed by Infinite. Public install artifacts only.\n"
    const decoyPath = join(root, "decoy.ts")
    writeFileSync(decoyPath, decoyContents)
    mkdirSync(join(root, "src/lib"), { recursive: true })
    const analyticsPath = join(root, "src/lib/infinite-analytics.ts")
    symlinkSync(decoyPath, analyticsPath)

    const originalMain = readFileSync(join(root, "src/main.tsx"), "utf8")
    const originalHtml = readFileSync(join(root, "index.html"), "utf8")

    const plan = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: {
        ga4: {
          measurementId: "G-TEST123"
        }
      }
    })
    expect(plan.blockers).toEqual([])

    expect(() =>
      applyInstallation({ root, workspaceId: "ws_test", plan })
    ).toThrow(/symlink/)

    expect(readFileSync(join(root, "src/main.tsx"), "utf8")).toBe(originalMain)
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe(originalHtml)
    expect(lstatSync(analyticsPath).isSymbolicLink()).toBe(true)
    expect(readFileSync(decoyPath, "utf8")).toBe(decoyContents)
    expect(existsSync(join(root, installManifestRelativePath))).toBe(false)
  })

  it("FIX 3: restoreSnapshot rejects a symlink on the rollback path (writeFileAtomic guard)", () => {
    // Apply successfully so we have a modified main on disk
    const root = copyFixture("vite-react-basic")
    const plan = planInstallation({
      root,
      inspect: inspectWorkspace(root),
      workspaceId: "ws_test",
      artifacts: { ga4: { measurementId: "G-TEST123" } }
    })
    expect(plan.blockers).toEqual([])
    applyInstallation({ root, workspaceId: "ws_test", plan })

    // Snapshot src/main.tsx while it is a regular file
    const snapshot = snapshotFiles(root, ["src/main.tsx"])

    // Replace src/main.tsx with a symlink pointing at a decoy
    const mainPath = join(root, "src/main.tsx")
    const decoyPath = join(root, "decoy-main.tsx")
    const appliedMain = readFileSync(mainPath, "utf8")
    writeFileSync(decoyPath, appliedMain)
    rmSync(mainPath)
    symlinkSync(decoyPath, mainPath)
    expect(lstatSync(mainPath).isSymbolicLink()).toBe(true)

    // Mutate decoy so snapshot content differs from current symlink target,
    // forcing restoreSnapshot to attempt a write
    writeFileSync(decoyPath, appliedMain + "\n// mutated\n")

    // restoreSnapshot must throw rather than write through the symlink
    expect(() => restoreSnapshot(root, snapshot)).toThrow(/symlink/)

    // The decoy (symlink target) was NOT overwritten
    expect(readFileSync(decoyPath, "utf8")).toBe(appliedMain + "\n// mutated\n")
  })
})
