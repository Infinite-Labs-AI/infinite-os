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
import { detectConversionElements, detectOutcomes, type ConversionElementFinding, type OutcomeFinding } from "./outcomes.js"
import { detectPrivacyPages, type PrivacyPageFinding } from "./privacy-page.js"
import { detectRedirects, type RedirectFinding } from "./redirects.js"
import { detectServerMount, type ServerMountFinding } from "./server-mount.js"
import { isNonProductPath, routePathOf, type Finding } from "./shared.js"

export interface StaticDetections {
  serverMount: ServerMountFinding[]
  layout: LayoutFinding[]
  outcomes: OutcomeFinding[]
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

/** Static, file-routed pages, most conversion-relevant first, then by path. */
export function detectPages(snapshot: RepoSnapshot): string[] {
  const routes = new Set<string>()
  for (const path of snapshot.files.keys()) {
    if (isNonProductPath(path)) continue
    if (/(?:^|\/)route\.[cm]?[jt]s$/.test(path) || /(?:^|\/)pages\/api\//.test(path)) continue
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
    layout: detectLayout(snapshot, framework),
    outcomes,
    conversionElements: detectConversionElements(snapshot),
    auth: detectAuth(snapshot),
    csp: detectCspOwners(snapshot),
    redirects: detectRedirects(snapshot, countedPaths),
    privacy: detectPrivacyPages(snapshot),
    fbcWriters: detectFbcWriters(snapshot),
    metaBrowserStandardEvents: detectMetaBrowserStandardEvents(snapshot),
    cmp: detectCmp(snapshot),
    pages: detectPages(snapshot)
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

/** A JobScan carries `snapshot` + `detections`; a bare ScanResult does not (a programming error). */
export function assertJobScan(scan: ScanResult): asserts scan is JobScan {
  const candidate = scan as Partial<JobScan>
  if (!candidate.snapshot || !candidate.detections) {
    throw new Error("JobRegistry needs a JobScan (ScanResult + snapshot + detections); build it with scanForJobs(scan)")
  }
}
