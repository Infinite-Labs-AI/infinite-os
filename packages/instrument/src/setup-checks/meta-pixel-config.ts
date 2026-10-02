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
//   • managed block with the wrong counts/order → problem (the 849ccf1 near-miss census), counted
//                                                  over EVERY managed block on the page together.
// One finding per distinct verdict, naming up to five files and counting the rest — never one line
// per page. A repo with no Meta pixel at all gets no line from here: the click-id check's single
// "no fbq('init') found" line covers both checks, and this check still answers undetermined.
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
  type MetaAutoConfigVerdict,
  type MetaCensusIssue
} from "../providers/meta-browser/autoconfig.js"
import { META_CLICK_ID_ACCESSOR } from "../providers/meta-browser/click-id.js"

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
/** The managed Next module before a36660c (infinite-tag < 0.7): a `String.raw` template, quotes unescaped. */
const BOOTSTRAP_RAW_TEMPLATE = /const bootstrapSource = String\.raw`([^`]*)`/

/** Every `<!-- infinite:start -->` … `<!-- infinite:end -->` block in a file, in order. */
function managedHtmlBlocks(contents: string): Array<[number, number]> {
  const blocks: Array<[number, number]> = []
  let from = 0
  for (;;) {
    const start = contents.indexOf(MANAGED_HTML_START, from)
    if (start === -1) break
    const end = contents.indexOf(MANAGED_HTML_END, start + MANAGED_HTML_START.length)
    if (end === -1) break
    const blockEnd = end + MANAGED_HTML_END.length
    blocks.push([start, blockEnd])
    from = blockEnd
  }
  return blocks
}

/**
 * Split a file into managed and adopted script bytes. EVERY managed block is its own managed unit:
 * a page that carries infinite-tag's block twice (a merge that kept both sides — the 849ccf1 shape)
 * runs `fbq('init')` twice, and the census must see both blocks, not file the second one as the
 * site's own code.
 */
export function metaSourceUnits(file: string, contents: string): MetaSourceUnit[] {
  const blocks = managedHtmlBlocks(contents)
  if (blocks.length > 0) {
    const units: MetaSourceUnit[] = blocks.map(([start, blockEnd]) => ({
      file,
      text: contents.slice(start, blockEnd),
      managed: true,
      line: lineNumberAt(contents, start),
      verbatim: true,
      offset: start
    }))
    // Whatever else the page carries is the site's own (adopted) code. Blanked rather than cut so
    // offsets — and therefore line numbers — stay true.
    let adopted = contents
    for (const [start, blockEnd] of blocks) {
      adopted = adopted.slice(0, start) + adopted.slice(start, blockEnd).replace(/[^\n]/g, " ") + adopted.slice(blockEnd)
    }
    units.push({ file, text: adopted, managed: false, line: 1, verbatim: true, offset: 0 })
    return units
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
        // An unreadable literal falls through: the file is still infinite-tag's own.
      }
    }
    const template = BOOTSTRAP_RAW_TEMPLATE.exec(contents)
    if (template) {
      // String.raw keeps the bytes as written, so the template body IS the bootstrap source.
      const offset = template.index + template[0].indexOf("`") + 1
      return [{ file, text: template[1] as string, managed: true, line: lineNumberAt(contents, offset), verbatim: true, offset }]
    }
    // A file infinite-tag marked as its own is never the site's (adopted) pixel, whatever its shape.
    return [{ file, text: contents, managed: true, line: 1, verbatim: true, offset: 0 }]
  }
  return [{ file, text: contents, managed: false, line: 1, verbatim: true, offset: 0 }]
}

export interface MetaPixelConfigInput {
  files: ReadonlyMap<string, string>
}

const MANAGED_CAPTURE = new RegExp(String.raw`window\.${META_CLICK_ID_ACCESSOR}\s*=\s*function`)

/** At most this many files are named in one finding; the rest are counted. */
const MAX_NAMED_FILES = 5

/** One finding's worth of identical verdicts, gathered across every file that produced it. */
interface Group {
  code: SetupFinding["code"]
  state: SetupFinding["state"]
  confidence: SetupFinding["confidence"]
  /** First occurrence: where the finding points. */
  file: string
  line: number
  files: string[]
  pixelId?: string
  reason?: string
  issues?: string[]
}

export function checkMetaPixelConfig(input: MetaPixelConfigInput): SetupCheckResult {
  // ONE finding per distinct verdict, not one per page: a 31-page static site with its own pixel on
  // every page is one decision for the customer, and 31 identical lines would bury real problems.
  const groups = new Map<string, Group>()
  const add = (key: string, group: Omit<Group, "files">) => {
    const existing = groups.get(key)
    if (existing) {
      if (!existing.files.includes(group.file)) existing.files.push(group.file)
      return
    }
    groups.set(key, { ...group, files: [group.file] })
  }
  let sawPixel = false
  let sawManagedCapture = false

  for (const [file, contents] of input.files) {
    const units = metaSourceUnits(file, contents)
    for (const unit of units) {
      if (unit.managed && MANAGED_CAPTURE.test(unit.text)) sawManagedCapture = true
      const pixelIds = extractMetaPixelIds(unit.text)
      if (pixelIds.length === 0) continue
      sawPixel = true
      for (const pixelId of pixelIds) {
        const verdict = checkMetaAutoConfigOptOut(unit.text, pixelId, unit.managed ? "managed" : "adopted")
        const line = lineOf(unit, contents, pixelId)
        const [code, confidence] = VERDICT_FINDING[verdict.state]
        add([code, pixelId, verdict.reason].join("|"), {
          code,
          state: verdict.state,
          confidence,
          file,
          line,
          pixelId,
          reason: verdict.reason
        })
      }
    }
    // The census runs over ALL of this file's managed bytes together: one page, one bootstrap init
    // per pixel, however many managed blocks the page ended up carrying.
    const managed = units.filter((unit) => unit.managed)
    if (managed.length === 0) continue
    const issues = censusManagedMetaSnippet(managed.map((unit) => unit.text).join("\n")).map(describeIssue)
    if (issues.length > 0) {
      add(["INF_SETUP_META_SNIPPET_CENSUS", ...issues].join("|"), {
        code: "INF_SETUP_META_SNIPPET_CENSUS",
        state: "problem",
        confidence: "certain",
        file,
        line: (managed[0] as MetaSourceUnit).line,
        issues
      })
    }
  }

  const findings = [...groups.values()].map(toFinding)
  if (!sawPixel && sawManagedCapture) {
    // Our own capture is here but no pixel init could be read beside it: say so, never pass.
    findings.push({
      check: "meta_pixel_config",
      code: "INF_SETUP_META_AUTOCONFIG_UNDETERMINED",
      state: "undetermined",
      confidence: "certain",
      message: metaAutoConfigUndeterminedMessage({ reason: "pixel_not_initialised" })
    })
  }
  if (!sawPixel && !sawManagedCapture) {
    // No Meta pixel anywhere in source. The click-id check already reports that once, in one line
    // that names both questions it leaves open; a second Meta line would be noise on a site that may
    // not use Meta at all. The check itself still answers UNDETERMINED — never a pass.
    return { check: "meta_pixel_config", state: "undetermined", findings }
  }
  return { check: "meta_pixel_config", state: worstState(findings), findings }
}

const VERDICT_FINDING: Record<
  MetaAutoConfigVerdict["state"],
  readonly [SetupFinding["code"], SetupFinding["confidence"]]
> = {
  ok: ["INF_SETUP_META_AUTOCONFIG_OFF", "certain"],
  problem: ["INF_SETUP_META_AUTOCONFIG_MANAGED_ON", "certain"],
  info: ["INF_SETUP_META_AUTOCONFIG_ADOPTED_ON", "likely"],
  undetermined: ["INF_SETUP_META_AUTOCONFIG_UNDETERMINED", "certain"]
}

function toFinding(group: Group): SetupFinding {
  const named = group.files.slice(0, MAX_NAMED_FILES)
  const where = { files: named, remaining: group.files.length - named.length }
  const at = { pixelId: group.pixelId ?? "", reason: group.reason ?? "", ...where }
  const message = (() => {
    switch (group.code) {
      case "INF_SETUP_META_AUTOCONFIG_OFF":
        return metaAutoConfigOffMessage(at)
      case "INF_SETUP_META_AUTOCONFIG_MANAGED_ON":
        return metaAutoConfigManagedOnMessage(at)
      case "INF_SETUP_META_AUTOCONFIG_ADOPTED_ON":
        return metaAutoConfigAdoptedOnMessage(at)
      case "INF_SETUP_META_SNIPPET_CENSUS":
        return metaSnippetCensusMessage({ ...where, issues: group.issues ?? [] })
      default:
        return metaAutoConfigUndeterminedMessage(at)
    }
  })()
  return {
    check: "meta_pixel_config",
    code: group.code,
    state: group.state,
    confidence: group.confidence,
    file: group.file,
    line: group.line,
    message
  }
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
