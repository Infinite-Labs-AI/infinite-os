// The static CMP / cookie-banner detector (lane O8). Shared by the allowlist (every detected CMP or
// banner file is globally denied: Infinite never adds, changes or checks a cookie banner) and by the
// grader input `cmpDetected` (a third-party CMP may hold GA4 / Meta while Infinite's own consent mode
// is `not_required`, §3h.8 / R2-19, so a missing beacon there is `held_by_consent`, never a problem).
//
// It only RECORDS what is there. Nothing in this lane edits, hides, re-orders or tests a banner.
import type { CmpDetected } from "../wizard/contracts/test-engine.js"
import type { RepoSnapshot } from "./repo-files.js"
import { isCodeFile, isHtmlFile, isNonProductPath, sortFindings, textMatches, type Finding } from "./detectors/shared.js"

export type CmpVendor = Exclude<CmpDetected, null>

export interface CmpFinding extends Finding {
  vendor: CmpVendor
  /** `loader` = the vendor's script/SDK; `banner` = a hand-written banner component or a banner library. */
  kind: "loader" | "banner"
}

export interface CmpDetection {
  /** The grader input: the first named vendor found (onetrust > cookiebot > usercentrics), else `other`, else null. */
  cmp: CmpDetected
  findings: CmpFinding[]
  /**
   * The CMP / banner FILES, globally denied to agents: a banner component (by its name), a file that
   * imports a banner library, or a file dedicated to the CMP (its path names cookie/consent/cmp or the
   * vendor). A CMP loader line inside a shared file (a layout that also holds the GA4 tag) does not deny
   * the whole file; that line is protected hunk by hunk (`allow.ts` `touchesConsent`).
   */
  files: string[]
}

const VENDOR_PATTERNS: Array<{ vendor: CmpVendor; kind: "loader" | "banner"; pattern: RegExp }> = [
  { vendor: "onetrust", kind: "loader", pattern: /cdn\.cookielaw\.org|otSDKStub\.js|optanon|OneTrust\b/g },
  { vendor: "cookiebot", kind: "loader", pattern: /consent\.cookiebot\.com|\bCookiebot\b|CookieConsent\.(?:renew|show)\b/g },
  { vendor: "usercentrics", kind: "loader", pattern: /usercentrics\.eu|\bUC_UI\b|@usercentrics\//g },
  {
    vendor: "other",
    kind: "loader",
    pattern:
      /\bcmp\.osano\.com|\bosano\b|iubenda\.com|app\.termly\.io|cdn-cookieyes\.com|sdk\.privacy-center\.org|\bDidomi\b|quantcast\.mgr\.consensu\.org|\b__tcfapi\b|consentmanager\.net|cookie-script\.com|klaro(?:\.js|\/)|@cookiehub\/|cookiehub\.net/g
  },
  {
    vendor: "other",
    kind: "banner",
    pattern: /from\s+["'](?:react-cookie-consent|vanilla-cookieconsent|cookieconsent|@consent-manager\/[^"']*|react-cookie-banner|@porscheofficial\/cookie-consent-banner-react)["']|require\(\s*["'](?:react-cookie-consent|vanilla-cookieconsent|cookieconsent)["']\s*\)/g
  }
]

/** A hand-written banner component, by its file name. */
const BANNER_FILE = /(?:^|\/)[^/]*(?:cookie[-_]?(?:banner|consent|notice|bar)|consent[-_]?(?:banner|manager|modal|bar))[^/]*\.(?:[cm]?[jt]sx?|vue|svelte|astro|html?)$/i
/** A file whose path says it is about the CMP (so a loader found there makes the whole file CMP-owned). */
const CMP_DEDICATED_PATH = /(?:^|\/)[^/]*(?:cookie|consent|cmp|onetrust|cookiebot|usercentrics|didomi|osano|iubenda|termly|cookieyes)[^/]*$/i

const NAMED_ORDER: readonly CmpVendor[] = ["onetrust", "cookiebot", "usercentrics"]

/** Detects CMP loaders and banner files. Pure: the same snapshot always yields the same result. */
export function detectCmp(snapshot: RepoSnapshot): CmpDetection {
  const findings: CmpFinding[] = []
  for (const [path, text] of snapshot.files) {
    if (isNonProductPath(path) || !(isCodeFile(path) || isHtmlFile(path))) continue
    if (BANNER_FILE.test(path)) findings.push({ file: path, line: 1, detail: "banner component file", vendor: "other", kind: "banner" })
    for (const { vendor, kind, pattern } of VENDOR_PATTERNS) {
      const first = textMatches(text, new RegExp(pattern.source, "g"))[0]
      if (first) findings.push({ file: path, line: first.line, detail: `${vendor} ${kind}`, vendor, kind })
    }
  }
  const sorted = sortFindings(findings)
  const vendors = new Set(sorted.map((finding) => finding.vendor))
  const named = NAMED_ORDER.find((vendor) => vendors.has(vendor))
  const cmp: CmpDetected = named ?? (sorted.length > 0 ? "other" : null)
  const files = sorted
    .filter((finding) => finding.kind === "banner" || CMP_DEDICATED_PATH.test(finding.file))
    .map((finding) => finding.file)
  return { cmp, findings: sorted, files: [...new Set(files)].sort() }
}
