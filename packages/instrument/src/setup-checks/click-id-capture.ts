// Check 3 — is Meta's `_fbc` click id captured where a visitor LANDS?
//
// `_fbc` is written by `fbevents.js` from the `fbclid` parameter on the URL of the page the pixel
// runs on. An ad click puts `fbclid` on the LANDING url and nowhere else: one navigation later it
// is gone. So a pixel that boots only on a conversion or thank-you page has nothing to save, and
// every conversion sent from that site reaches Meta with no click id — which is the same thing as
// Meta being unable to attribute it to the ad that paid for it.
//
// Meta's guidance, verbatim: save the `_fbp` and `_fbc` cookies as early as possible; do not
// retrieve them only from down-funnel events.
//
// Two shapes of this defect are readable from source:
//   • a pixel that initialises ONLY in page-scoped files and in no shared entry;
//   • a multi-page static site where some pages boot the pixel and others do not — any page can be
//     an ad's landing page, because ads link deep.
//
// What is NOT readable is a pixel injected by a tag manager, by the hosting edge, or by a
// dependency. That case is `undetermined` and says so. It is never reported as "not needed".
import { extractMetaPixelIds } from "../meta-live/config-probe.js"

import {
  clickIdMissingPagesMessage,
  clickIdNotAtLandingMessage,
  clickIdPresentMessage,
  clickIdUndeterminedMessage
} from "./copy.js"
import { worstState, type SetupCheckResult, type SetupFinding } from "./types.js"

/**
 * Files every route loads. An `fbq('init')` here runs on the first page a visitor sees, whichever
 * page that is — which is the whole property this check is about.
 */
export const SHARED_ENTRY_PATTERNS: readonly RegExp[] = [
  /(^|\/)index\.html?$/i,
  /(^|\/)app\/layout\.[jt]sx?$/,
  /(^|\/)app\/[^/]*\/layout\.[jt]sx?$/,
  /(^|\/)pages\/_app\.[jt]sx?$/,
  /(^|\/)pages\/_document\.[jt]sx?$/,
  /(^|\/)lib\/infinite-analytics\.[jt]sx?$/,
  /(^|\/)(main|index|App|root)\.[jt]sx?$/,
  /(^|\/)_layout\.[jt]sx?$/,
  /(^|\/)App\.vue$/,
  /(^|\/)(app|layout)\.svelte$/
]

export function isSharedEntry(file: string): boolean {
  return SHARED_ENTRY_PATTERNS.some((pattern) => pattern.test(file))
}

/** A real, servable HTML page — not a fragment, an email template, or a partial. */
export function isHtmlPage(file: string, contents: string): boolean {
  return /\.html?$/i.test(file) && /<body\b/i.test(contents) && /<\/head>/i.test(contents)
}

/** The entries a customer is told to move the bootstrap into, narrowed by what this repo has. */
function sharedCandidates(files: ReadonlyMap<string, string>): string[] {
  const present = [...files.keys()].filter(isSharedEntry)
  return present.length > 0 ? present.slice(0, 3) : ["app/layout.tsx", "pages/_app.tsx", "index.html"]
}

const MAX_NAMED_PAGES = 5

export interface ClickIdCaptureInput {
  files: ReadonlyMap<string, string>
}

export function checkClickIdCapture(input: ClickIdCaptureInput): SetupCheckResult {
  const findings: SetupFinding[] = []
  const initFiles: string[] = []
  const htmlPagesWith: string[] = []
  const htmlPagesWithout: string[] = []

  for (const [file, contents] of input.files) {
    const initialises = extractMetaPixelIds(contents).length > 0
    if (initialises) initFiles.push(file)
    if (isHtmlPage(file, contents)) (initialises ? htmlPagesWith : htmlPagesWithout).push(file)
  }

  if (initFiles.length === 0) {
    findings.push({
      check: "click_id_capture",
      code: "INF_SETUP_CLICK_ID_UNDETERMINED",
      state: "undetermined",
      confidence: "certain",
      message: clickIdUndeterminedMessage()
    })
    return { check: "click_id_capture", state: "undetermined", findings }
  }

  // Shape 2 first: on a multi-page static site this is the concrete, page-named version of the
  // same defect, and naming the pages is far more useful than naming the pattern.
  if (htmlPagesWith.length > 0 && htmlPagesWithout.length > 0) {
    const named = htmlPagesWithout.slice(0, MAX_NAMED_PAGES)
    findings.push({
      check: "click_id_capture",
      code: "INF_SETUP_CLICK_ID_NOT_AT_LANDING",
      state: "problem",
      confidence: "certain",
      file: named[0] as string,
      message: clickIdMissingPagesMessage({
        withPixel: htmlPagesWith.slice(0, MAX_NAMED_PAGES),
        withoutPixel: named,
        remaining: htmlPagesWithout.length - named.length
      })
    })
    return { check: "click_id_capture", state: worstState(findings), findings }
  }

  const shared = initFiles.filter(isSharedEntry)
  if (shared.length > 0) {
    findings.push({
      check: "click_id_capture",
      code: "INF_SETUP_CLICK_ID_PRESENT",
      state: "ok",
      confidence: "certain",
      file: shared[0] as string,
      message: clickIdPresentMessage({ file: shared[0] as string })
    })
    return { check: "click_id_capture", state: "ok", findings }
  }

  findings.push({
    check: "click_id_capture",
    code: "INF_SETUP_CLICK_ID_NOT_AT_LANDING",
    state: "problem",
    confidence: "certain",
    file: initFiles[0] as string,
    message: clickIdNotAtLandingMessage({
      initFiles: initFiles.slice(0, MAX_NAMED_PAGES),
      sharedCandidates: sharedCandidates(input.files)
    })
  })
  return { check: "click_id_capture", state: worstState(findings), findings }
}
