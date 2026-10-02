// Job 2 (`unusual_layout`) trigger detector (lane O8): a layout the installer can only plan, never
// apply, so the user's agent must put the managed tag in the real app shell / builder config.
//
// - `custom_builder`: the site is built by a tool the installer has no adapter for (Astro, Eleventy,
//   Gatsby, Nuxt, SvelteKit, Remix, Hugo-like generators, a hand-rolled webpack/rollup/gulp build).
// - `no_app_shell`: no supported framework and no HTML entry or layout the tag could go in.
// - `ambiguous_monorepo`: a workspace repo with two or more web apps and no app root chosen.
// A supported framework (Next app/pages router, Vite React, static HTML) yields no finding here: the
// installer handles it, and `requiresManual` leftovers are lane O7's open jobs.
import { supportedFrameworks } from "../../types.js"
import type { RepoSnapshot } from "../repo-files.js"
import { isHtmlFile, isNonProductPath, sortFindings, type Finding } from "./shared.js"

export type LayoutKind = "custom_builder" | "no_app_shell" | "ambiguous_monorepo"

export interface LayoutFinding extends Finding {
  kind: LayoutKind
}

const BUILDER_FILES: Array<{ pattern: RegExp; builder: string }> = [
  { pattern: /(?:^|\/)astro\.config\.[cm]?[jt]s$/, builder: "Astro" },
  { pattern: /(?:^|\/)(?:\.eleventy\.[cm]?js|eleventy\.config\.[cm]?[jt]s)$/, builder: "Eleventy" },
  { pattern: /(?:^|\/)gatsby-(?:config|browser|ssr)\.[cm]?[jt]sx?$/, builder: "Gatsby" },
  { pattern: /(?:^|\/)nuxt\.config\.[cm]?[jt]s$/, builder: "Nuxt" },
  { pattern: /(?:^|\/)svelte\.config\.[cm]?js$/, builder: "SvelteKit" },
  { pattern: /(?:^|\/)remix\.config\.[cm]?js$/, builder: "Remix" },
  { pattern: /(?:^|\/)gulpfile\.[cm]?[jt]s$/, builder: "gulp" },
  { pattern: /(?:^|\/)webpack\.config\.[cm]?[jt]s$/, builder: "webpack" },
  { pattern: /(?:^|\/)rollup\.config\.[cm]?[jt]s$/, builder: "rollup" },
  { pattern: /(?:^|\/)parcel\.config\.[cm]?js$/, builder: "Parcel" }
]

const WEB_APP_DEPENDENCIES = ["next", "vite", "react-dom", "astro", "nuxt", "@sveltejs/kit", "gatsby", "@remix-run/react", "vue"]

function underAppRoot(path: string, appRoot: string): boolean {
  return appRoot === "." || path === appRoot || path.startsWith(`${appRoot}/`)
}

/** Pure. `framework` is the installer scan's framework id (anything outside the supported list is unsupported). */
export function detectLayout(snapshot: RepoSnapshot, framework: string): LayoutFinding[] {
  const findings: LayoutFinding[] = []
  const supported = (supportedFrameworks as readonly string[]).includes(framework)

  if (!supported) {
    for (const path of snapshot.files.keys()) {
      if (isNonProductPath(path) || !underAppRoot(path, snapshot.appRoot)) continue
      const builder = BUILDER_FILES.find((entry) => entry.pattern.test(path))
      if (builder) findings.push({ file: path, line: 1, detail: `${builder.builder} build`, kind: "custom_builder" })
    }
    const hasHtml = [...snapshot.files.keys()].some((path) => isHtmlFile(path) && !isNonProductPath(path) && underAppRoot(path, snapshot.appRoot))
    if (findings.length === 0 && !hasHtml) {
      const manifest = snapshot.appRoot === "." ? "package.json" : `${snapshot.appRoot}/package.json`
      const evidenceFile = snapshot.files.has(manifest) ? manifest : ([...snapshot.files.keys()][0] ?? manifest)
      findings.push({ file: evidenceFile, line: 1, detail: `no app shell for framework "${framework}"`, kind: "no_app_shell" })
    }
  }

  if (snapshot.appRoot === ".") {
    const root = snapshot.packages.find((pkg) => pkg.dir === ".")
    const isWorkspace = (root?.workspaces.length ?? 0) > 0 || snapshot.files.has("pnpm-workspace.yaml")
    if (isWorkspace) {
      const webApps = snapshot.packages.filter((pkg) => pkg.dir !== "." && pkg.deps.some((dep) => WEB_APP_DEPENDENCIES.includes(dep)))
      if (webApps.length >= 2) {
        for (const app of webApps) {
          findings.push({ file: `${app.dir}/package.json`, line: 1, detail: `one of ${webApps.length} web apps in the workspace`, kind: "ambiguous_monorepo" })
        }
      }
    }
  }
  return sortFindings(findings)
}
