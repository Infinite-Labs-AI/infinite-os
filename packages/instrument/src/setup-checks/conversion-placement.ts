// Check 1 — is `data-conversion` on an element the runtime will actually treat as the author meant?
//
// The night this check exists for: a `<button data-conversion="signup">` sat inside a done-for-you
// lead form. Every review passed it — the attribute is the right attribute with the right value,
// and `infinite-tag mark` skipped the element as "already marked (data-conversion)". But the
// runtime reads that attribute through TWO listeners: `[data-conversion="signup"]` on click and
// `form[data-conversion="signup"]` on submit. On a button only the click lane matches, so every
// press was filed as a completed sign-up at the moment of the click — flattering, and wrong, for as
// long as it existed.
//
// The rule below is never restated: it is derived from the runtime source in `contract.ts`.
import { knownConversionValues, lanesFor, lanesMissedBy, type ConversionLane } from "./contract.js"
import { elementSites, enclosedBy, hasAttributeName, literalAttributeValue } from "./markup.js"
import {
  contractUnreadableMessage,
  unknownValueMessage,
  unreadableConversionMessage,
  wrongElementMessage
} from "./copy.js"
import { worstState, type SetupCheckResult, type SetupFinding } from "./types.js"

export interface ConversionPlacementInput {
  /** App-root-relative path → file contents. */
  files: ReadonlyMap<string, string>
  lanes: readonly ConversionLane[]
}

export function checkConversionPlacement(input: ConversionPlacementInput): SetupCheckResult {
  const findings: SetupFinding[] = []

  if (input.lanes.length === 0) {
    // A contract we could not read is not a clean bill of health, and never reports as one.
    findings.push({
      check: "conversion_placement",
      code: "INF_SETUP_RUNTIME_CONTRACT_UNREADABLE",
      state: "undetermined",
      confidence: "certain",
      message: contractUnreadableMessage()
    })
    return { check: "conversion_placement", state: "undetermined", findings }
  }

  const known = knownConversionValues(input.lanes)

  for (const [file, contents] of input.files) {
    for (const site of elementSites(contents)) {
      if (!hasAttributeName(site.openingTag, "data-conversion")) continue
      const value = literalAttributeValue(site.openingTag, "data-conversion")
      if (value === null) {
        findings.push({
          check: "conversion_placement",
          code: "INF_SETUP_CONVERSION_UNREADABLE",
          state: "undetermined",
          confidence: "certain",
          file,
          line: site.line,
          message: unreadableConversionMessage({ tag: site.tag, file, line: site.line })
        })
        continue
      }

      if (!known.includes(value)) {
        findings.push({
          check: "conversion_placement",
          code: "INF_SETUP_CONVERSION_UNKNOWN_VALUE",
          state: "problem",
          confidence: "certain",
          file,
          line: site.line,
          message: unknownValueMessage({ value, tag: site.tag, known, file, line: site.line })
        })
        continue
      }

      const firing = lanesFor(input.lanes, value, site.tag)
      const missed = lanesMissedBy(input.lanes, value, site.tag)
      if (missed.length === 0) continue

      // A lane is only MISSED in a way worth reporting when the element the lane wanted is right
      // there wrapping this one. A `<a data-conversion="signup">` that is simply a link to /signup
      // is correct as written — the click lane is exactly the lane it should be in, and flagging it
      // would be the false red that gets the whole check muted.
      const wantedTag = missed[0]?.requiredTag
      if (!wantedTag) continue
      const enclosure = enclosedBy(contents, site.offset, wantedTag)
      if (enclosure === "unreadable") {
        findings.push({
          check: "conversion_placement",
          code: "INF_SETUP_CONVERSION_UNREADABLE",
          state: "undetermined",
          confidence: "certain",
          file,
          line: site.line,
          message: unreadableConversionMessage({ tag: site.tag, file, line: site.line })
        })
        continue
      }
      if (enclosure === "outside") continue

      findings.push({
        check: "conversion_placement",
        code: "INF_SETUP_CONVERSION_WRONG_ELEMENT",
        state: "problem",
        confidence: "certain",
        file,
        line: site.line,
        message: wrongElementMessage({ value, tag: site.tag, firing, missed, file, line: site.line })
      })
    }
  }

  return { check: "conversion_placement", state: worstState(findings), findings }
}
