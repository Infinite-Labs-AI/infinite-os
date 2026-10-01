// Check 4 — Meta's automatic events, and the shape of the Meta block infinite-tag wrote.
//
// The pure rules live in `providers/meta-browser/autoconfig.ts` (ported from infinite.fast's live
// guardrail and injector census) so a later live check can run them on served bytes. This file only
// decides WHICH bytes are infinite-tag's (managed) and which the site already had (adopted), and
// turns verdicts into findings:
//   • managed pixel, automatic events on        → problem (our own code is wrong);
//   • adopted pixel, automatic events on        → info (founder decision 10: a plan line later,
//                                                  never an automatic edit);
//   • cannot tell                               → undetermined (never a pass);
//   • managed block with the wrong counts/order → problem (the 849ccf1 near-miss census).
//
// READING MANAGED BYTES. A static/Vite page carries the managed block between
// `<!-- infinite:start -->` and `<!-- infinite:end -->`. The Next module carries it as a JSON string
// literal (`const bootstrapSource = "…"`), where every quote is escaped — a regex over the raw file
// sees `\"1234…\"` and finds no pixel at all. So the literal is DECODED before anything is matched;
// `metaSourceUnits` is shared with the click-id check for the same reason.
import { MANAGED_HTML_END, MANAGED_HTML_START } from "../frameworks/managed-html.js"
import { isManagedInfiniteFile } from "../frameworks/managed-files.js"
import { lineNumberAt } from "../harness/scan.js"
import { extractMetaPixelIds } from "../meta-live/config-probe.js"
import { maskPixelId } from "../meta-live/copy.js"
import {
  censusManagedMetaSnippet,
  checkMetaAutoConfigOptOut,
  type MetaCensusIssue
} from "../providers/meta-browser/autoconfig.js"

import {
  metaAutoConfigAdoptedOnMessage,
  metaAutoConfigManagedOnMessage,
  metaAutoConfigOffMessage,
  metaAutoConfigUndeterminedMessage,
  metaSnippetCensusMessage
} from "./copy.js"
import { worstState, type SetupCheckResult, type SetupFinding } from "./types.js"

/** One stretch of a file's script bytes, labelled by who wrote it. */
export interface MetaSourceUnit {
  file: string
  text: string
  managed: boolean
  /** 1-based line where the unit starts in the file. */
  line: number
  /** True when `text` is a verbatim slice of the file starting at `offset`. */
  verbatim: boolean
  offset: number
}

const BOOTSTRAP_LITERAL = /const bootstrapSource = ("(?:[^"\\\n]|\\.)*")/

/** Split a file into managed and adopted script bytes. */
export function metaSourceUnits(file: string, contents: string): MetaSourceUnit[] {
  const start = contents.indexOf(MANAGED_HTML_START)
  const end = start === -1 ? -1 : contents.indexOf(MANAGED_HTML_END, start)
  if (start !== -1 && end !== -1) {
    const blockEnd = end + MANAGED_HTML_END.length
    return [
      { file, text: contents.slice(start, blockEnd), managed: true, line: lineNumberAt(contents, start), verbatim: true, offset: start },
      // Whatever else the page carries is the site's own (adopted) code. Blanked rather than cut so
      // offsets — and therefore line numbers — stay true.
      {
        file,
        text: contents.slice(0, start) + contents.slice(start, blockEnd).replace(/[^\n]/g, " ") + contents.slice(blockEnd),
        managed: false,
        line: 1,
        verbatim: true,
        offset: 0
      }
    ]
  }
  if (isManagedInfiniteFile(contents)) {
    const literal = BOOTSTRAP_LITERAL.exec(contents)
    if (literal) {
      try {
        const decoded = JSON.parse(literal[1] as string) as unknown
        if (typeof decoded === "string") {
          return [{ file, text: decoded, managed: true, line: lineNumberAt(contents, literal.index), verbatim: false, offset: literal.index }]
        }
      } catch {
        // An unreadable managed literal falls through to a raw read, which finds nothing to judge.
      }
    }
  }
  return [{ file, text: contents, managed: false, line: 1, verbatim: true, offset: 0 }]
}

export interface MetaPixelConfigInput {
  files: ReadonlyMap<string, string>
}

export function checkMetaPixelConfig(input: MetaPixelConfigInput): SetupCheckResult {
  const findings: SetupFinding[] = []
  let sawPixel = false

  for (const [file, contents] of input.files) {
    for (const unit of metaSourceUnits(file, contents)) {
      const pixelIds = extractMetaPixelIds(unit.text)
      if (pixelIds.length === 0) continue
      sawPixel = true
      for (const pixelId of pixelIds) {
        const verdict = checkMetaAutoConfigOptOut(unit.text, pixelId, unit.managed ? "managed" : "adopted")
        const line = lineOf(unit, contents, pixelId)
        const at = { pixelId, file, reason: verdict.reason }
        switch (verdict.state) {
          case "ok":
            findings.push(finding("INF_SETUP_META_AUTOCONFIG_OFF", "ok", "certain", file, line, metaAutoConfigOffMessage(at)))
            break
          case "problem":
            findings.push(finding("INF_SETUP_META_AUTOCONFIG_MANAGED_ON", "problem", "certain", file, line, metaAutoConfigManagedOnMessage(at)))
            break
          case "info":
            findings.push(finding("INF_SETUP_META_AUTOCONFIG_ADOPTED_ON", "info", "likely", file, line, metaAutoConfigAdoptedOnMessage(at)))
            break
          case "undetermined":
            findings.push(finding("INF_SETUP_META_AUTOCONFIG_UNDETERMINED", "undetermined", "certain", file, line, metaAutoConfigUndeterminedMessage(at)))
            break
        }
      }
      if (unit.managed) {
        const issues = censusManagedMetaSnippet(unit.text)
        if (issues.length > 0) {
          findings.push(
            finding("INF_SETUP_META_SNIPPET_CENSUS", "problem", "certain", file, unit.line, metaSnippetCensusMessage({ file, issues: issues.map(describeIssue) }))
          )
        }
      }
    }
  }

  if (!sawPixel) {
    findings.push({
      check: "meta_pixel_config",
      code: "INF_SETUP_META_AUTOCONFIG_UNDETERMINED",
      state: "undetermined",
      confidence: "certain",
      message: metaAutoConfigUndeterminedMessage({ reason: "pixel_not_initialised" })
    })
  }
  return { check: "meta_pixel_config", state: worstState(findings), findings }
}

function finding(
  code: SetupFinding["code"],
  state: SetupFinding["state"],
  confidence: SetupFinding["confidence"],
  file: string,
  line: number,
  message: string
): SetupFinding {
  return { check: "meta_pixel_config", code, state, confidence, file, line, message }
}

function lineOf(unit: MetaSourceUnit, contents: string, pixelId: string): number {
  if (!unit.verbatim) return unit.line
  const at = unit.text.search(new RegExp(String.raw`fbq\(\s*["']init["']\s*,\s*["']${pixelId}["']`))
  return at === -1 ? unit.line : lineNumberAt(contents, unit.offset + at)
}

function describeIssue(issue: MetaCensusIssue): string {
  switch (issue.code) {
    case "init_count":
      return `pixel ${maskPixelId(issue.pixelId ?? "")} is initialised ${issue.count} times (expected exactly once)`
    case "capture_count":
      return `${issue.count} click-id captures (expected at most one)`
    case "matching_count":
      return `${issue.count} Advanced Matching accessors (expected at most one)`
    case "capture_after_init":
      return `the click-id capture runs after pixel ${maskPixelId(issue.pixelId ?? "")}'s init`
  }
}
