// Every static job detector in one pass (lane O8), plus the `JobScan` the registry seeds from.
//
// `JobScan` = the installer's ScanResult (lane O7) + the repo snapshot + these static detections. It is
// built ONCE per moment (`before`, and again when a `not_needed` claim is re-verified) and never
// persisted: detections are recomputed from the tree, so a re-verify sees the agent's edits.
import type { ScanResult } from "../../wizard/contracts/jobs.js"
import { detectCmp, type CmpDetection } from "../cmp.js"
import { loadRepoSnapshot, type RepoSnapshot } from "../repo-files.js"
import { detectMetaBrowserStandardEvents } from "./adopted-tags.js"
import { detectAuth, type AuthDetection } from "./auth.js"
import { detectCspOwners, type CspOwnerFinding } from "./csp-owner.js"
import { detectFbcWriters, type FbcWriterFinding } from "./fbc-writers.js"
import { detectLayout, type LayoutFinding } from "./layout.js"
import { detectConversionElements, detectConversionSuccessPaths, detectOutcomes, type ConversionElementFinding, type OutcomeFinding } from "./outcomes.js"
import { detectPrivacyPages, type PrivacyPageFinding } from "./privacy-page.js"
import { detectRedirects, type RedirectFinding } from "./redirects.js"
import { detectMiddlewareFiles, detectServerMount, type ServerMountFinding } from "./server-mount.js"
import { isNonProductPath, routePathOf, type Finding } from "./shared.js"

export interface StaticDetections {
  serverMount: ServerMountFinding[]
  /** The request middleware / proxy files (wired or not). */
  middleware: string[]
  layout: LayoutFinding[]
  outcomes: OutcomeFinding[]
  /** §3x.3 Where an outcome conversion succeeds in the browser (job 10's targets for signup/lead/booking/purchase/trial). */
  successPaths: ConversionElementFinding[]
  conversionElements: ConversionElementFinding[]
  auth: AuthDetection
  csp: CspOwnerFinding[]
  redirects: RedirectFinding[]
  privacy: PrivacyPageFinding[]
  fbcWriters: FbcWriterFinding[]
  metaBrowserStandardEvents: Finding[]
  cmp: CmpDetection
  /** Static page routes (no API routes, no dynamic segments), most conversion-relevant first. */
  pages: string[]
}

export interface JobScan extends ScanResult {
  snapshot: RepoSnapshot
  detections: StaticDetections
}

const PAGE_PRIORITY = [/^\/pricing$/, /^\/(?:sign-?up|register|get-started|start)$/, /^\/(?:demo|book|contact)/, /^\/(?:checkout|download)/, /^\/(?:features|product|about)/]

/** An HTML file the site serves as a page: anything on a static-HTML site, else only `public/` and the root entry. */
function isServedHtml(path: string, appRoot: string, framework: string | null): boolean {
  if (framework === null || framework === "static-html") return true
  const relative = appRoot === "." ? path : path.slice(appRoot.length + 1)
  const withoutSrc = relative.startsWith("src/") ? relative.slice(4) : relative
  return withoutSrc.startsWith("public/") || withoutSrc === "index.html"
}

/** Static, file-routed pages, most conversion-relevant first, then by path. */
export function detectPages(snapshot: RepoSnapshot, framework: string | null = null): string[] {
  const routes = new Set<string>()
  for (const path of snapshot.files.keys()) {
    if (isNonProductPath(path)) continue
    if (/\.html?$/i.test(path) && !isServedHtml(path, snapshot.appRoot, framework)) continue
    // Route handlers (any extension) and API routes are not pages: the dry load never GETs them.
    if (/(?:^|\/)route\.[cm]?[jt]sx?$/.test(path) || /(?:^|\/)pages\/api\//.test(path)) continue
    const route = routePathOf(path, snapshot.appRoot)
    if (route === null || route.includes("[") || route.startsWith("/api/") || route === "/api") continue
    routes.add(route)
  }
  const rank = (route: string): number => {
    const index = PAGE_PRIORITY.findIndex((pattern) => pattern.test(route))
    return index < 0 ? PAGE_PRIORITY.length : index
  }
  return [...routes].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
}

/** Pure: every static detector over one snapshot. */
export function detectStatic(snapshot: RepoSnapshot, framework: string): StaticDetections {
  const outcomes = detectOutcomes(snapshot)
  const countedPaths = outcomes.map((finding) => finding.route).filter((route): route is string => route !== null)
  return {
    serverMount: detectServerMount(snapshot),
    middleware: detectMiddlewareFiles(snapshot),
    layout: detectLayout(snapshot, framework),
    outcomes,
    conversionElements: detectConversionElements(snapshot),
    successPaths: detectConversionSuccessPaths(snapshot),
    auth: detectAuth(snapshot),
    csp: detectCspOwners(snapshot),
    redirects: detectRedirects(snapshot, countedPaths),
    privacy: detectPrivacyPages(snapshot),
    fbcWriters: detectFbcWriters(snapshot),
    metaBrowserStandardEvents: detectMetaBrowserStandardEvents(snapshot),
    cmp: detectCmp(snapshot),
    pages: detectPages(snapshot, framework)
  }
}

/** Builds the JobScan from an in-memory snapshot (tests, and callers that hold the snapshot). */
export function jobScanFrom(scan: ScanResult, snapshot: RepoSnapshot): JobScan {
  return { ...scan, snapshot, detections: detectStatic(snapshot, scan.framework) }
}

/**
 * Reads the tree (bounded, read-only) and builds the JobScan. `scan.root` is absolute, `scan.appRoot`
 * repo-relative. Lane O3 calls this again to re-verify a `not_needed` claim against the edited tree.
 */
export function scanForJobs(scan: ScanResult): JobScan {
  return jobScanFrom(scan, loadRepoSnapshot(scan.root, scan.appRoot))
}

/** True when the scan already carries the snapshot and the detections. */
export function isJobScan(scan: ScanResult): scan is JobScan {
  const candidate = scan as Partial<JobScan>
  return Boolean(candidate.snapshot && candidate.detections)
}
