// Job 14 (`privacy_paragraph`) trigger detector (lane O8): the site's privacy page, and which of the
// tools it already names. The job is seeded only when a tool is NEWLY installed by this run, the page
// exists, and the user approves the paragraph text in the plan; the agent then inserts the approved
// text verbatim into this one file.
import type { TestTool } from "../../wizard/contracts/test-engine.js"
import type { RepoSnapshot } from "../repo-files.js"
import { isNonProductPath, routePathOf, sortFindings, type Finding } from "./shared.js"

export interface PrivacyPageFinding extends Finding {
  route: string | null
  /** Which tools the page text already names. */
  names: Record<TestTool, boolean>
}

const PRIVACY_PATH = /(?:^|\/|[-_(])(?:privacy(?:-policy)?|datenschutz|confidentialite|cookie-policy|cookies-policy)(?:[-_.)/]|$)/i
const PAGE_FILE = /\.(?:[cm]?[jt]sx?|mdx?|html?|astro|vue|svelte)$/i

/**
 * Tool-specific phrases only: "infinite scroll" does not disclose Infinite's analytics, and a "Follow us
 * on Facebook" link does not disclose the Meta pixel (review P3-4).
 */
const TOOL_NAMES: Record<TestTool, RegExp> = {
  ga4: /google analytics|\bga4\b|googletagmanager/i,
  posthog: /posthog/i,
  meta: /\bmeta pixel\b|facebook pixel|\bmeta platforms\b|\bmeta conversions api\b|facebook conversions api/i,
  infinite: /\binfinite (?:analytics|tag)\b|\binfinite-tag\b|\binfinite\.(?:fast|inc)\b/i
}

/** Pure: privacy pages (routed pages, HTML and Markdown), first line of each. */
export function detectPrivacyPages(snapshot: RepoSnapshot): PrivacyPageFinding[] {
  const findings: PrivacyPageFinding[] = []
  for (const [path, text] of snapshot.files) {
    if (isNonProductPath(path) || !PAGE_FILE.test(path) || !PRIVACY_PATH.test(path)) continue
    const route = routePathOf(path, snapshot.appRoot)
    // A component named `privacy-toggle.tsx` outside the routes is not the page.
    const isMarkdownOrHtml = /\.(?:mdx?|html?)$/i.test(path)
    if (route === null && !isMarkdownOrHtml) continue
    const names = {} as Record<TestTool, boolean>
    for (const tool of Object.keys(TOOL_NAMES) as TestTool[]) names[tool] = TOOL_NAMES[tool].test(text)
    findings.push({ file: path, line: 1, detail: "privacy page", route, names })
  }
  return sortFindings(findings)
}
