import { describe, expect, it } from "vitest"

import { checkConversionPlacement } from "./conversion-placement.js"
import { runtimeConversionLanes } from "./contract.js"

const lanes = runtimeConversionLanes()

function check(file: string, contents: string) {
  return checkConversionPlacement({ files: new Map([[file, contents]]), lanes })
}

describe("data-conversion placement", () => {
  /** THE FIXTURE FOR THE DEFECT: the exact shape that shipped on our own done-for-you lead form. */
  it("catches the attribute on a button inside a form", () => {
    const result = check(
      "src/components/lead-form.tsx",
      [
        "export function LeadForm() {",
        "  return (",
        "    <form action=\"/api/lead\" method=\"post\">",
        "      <input type=\"email\" name=\"email\" />",
        "      <button data-conversion=\"signup\" type=\"submit\">Get started</button>",
        "    </form>",
        "  )",
        "}"
      ].join("\n")
    )
    expect(result.state).toBe("problem")
    expect(result.findings).toHaveLength(1)
    const finding = result.findings[0]!
    expect(finding.code).toBe("INF_SETUP_CONVERSION_WRONG_ELEMENT")
    expect(finding.confidence).toBe("certain")
    expect(finding.line).toBe(5)
    // It must name the element it is on, the lane that produces, and the lane that was meant.
    expect(finding.message).toContain("is on a <button> INSIDE a <form>")
    expect(finding.message).toContain('`[data-conversion="signup"]` on click')
    expect(finding.message).toContain('`form[data-conversion="signup"]` on submit')
    expect(finding.message).toContain("Move the attribute onto the enclosing <form> tag")
  })

  it("passes the same form when the attribute is on the form", () => {
    const result = check(
      "src/components/lead-form.tsx",
      '<form data-conversion="signup" method="post"><button type="submit">Go</button></form>'
    )
    expect(result.state).toBe("ok")
    expect(result.findings).toEqual([])
  })

  it("catches a value the runtime does not read at all", () => {
    const result = check("src/app/page.tsx", '<button data-conversion="lead">Send</button>')
    expect(result.state).toBe("problem")
    const finding = result.findings[0]!
    expect(finding.code).toBe("INF_SETUP_CONVERSION_UNKNOWN_VALUE")
    expect(finding.message).toContain('"checkout", "signup"')
    expect(finding.message).toContain("skips anything already carrying `data-conversion`")
  })

  it("says undetermined — never ok — for a computed attribute value", () => {
    const result = check("src/app/page.tsx", "<button data-conversion={kind}>Send</button>")
    expect(result.state).toBe("undetermined")
    expect(result.findings[0]!.code).toBe("INF_SETUP_CONVERSION_UNREADABLE")
    expect(result.findings[0]!.message).toContain("That is not a pass and not a failure")
  })
})
