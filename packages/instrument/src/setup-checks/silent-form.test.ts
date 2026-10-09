import { describe, expect, it } from "vitest"

import { checkSilentForms } from "./silent-form.js"

function check(file: string, contents: string) {
  return checkSilentForms({ files: new Map([[file, contents]]) })
}

const LEAD_FORM = [
  '<form id="contact-form" action="/api/lead" method="post">',
  '  <input type="email" name="email" />',
  '  <input type="text" name="company" />',
  '  <button type="submit">Request a demo</button>',
  "</form>"
].join("\n")

describe("a form that submits and emits nothing", () => {
  it("flags the lead form, as worth checking rather than as an accusation", () => {
    const result = check("src/components/contact.tsx", LEAD_FORM)
    expect(result.state).toBe("problem")
    const finding = result.findings[0]!
    expect(finding.code).toBe("INF_SETUP_FORM_NO_CONVERSION")
    expect(finding.confidence).toBe("likely")
    expect(finding.line).toBe(1)
    expect(finding.message.startsWith("Worth checking:")).toBe(true)
    expect(finding.message).toContain("it has a type=submit button")
    expect(finding.message).toContain("matching data-conversion marker on the <form> itself")
    expect(finding.message).toContain("does not follow imported or custom handlers")
    expect(finding.message).not.toContain("no analytics call")
    expect(finding.message).not.toContain("nothing here ever tries")
  })

  it("goes quiet once the form is marked", () => {
    expect(check("src/components/contact.tsx", LEAD_FORM.replace("<form ", '<form data-conversion="signup" ')).state).toBe("ok")
  })

  it("goes quiet when the submit control carries a cta id", () => {
    expect(
      check("src/components/contact.tsx", LEAD_FORM.replace("<button ", '<button data-analytics-cta-id="request_demo" ')).state
    ).toBe("ok")
  })

  // ---- the false-positive fixtures: every one of these is legitimately not a conversion --------

  it.each([
    ["login", '<form id="login" method="post"><input type="email" /><input type="password" /><button>Sign in</button></form>'],
    ["a GET query", '<form action="/results" method="get"><input type="email" /><button type="submit">Go</button></form>']
  ])("stays silent about a %s form", (_label, markup) => {
    expect(check("src/app/page.tsx", markup).state).toBe("ok")
  })

  /** The honest middle: a hand-rolled handler we cannot attribute to this form is undetermined. */
  it("says undetermined when the file already calls an analytics api directly", () => {
    const result = check(
      "src/components/contact.tsx",
      `${LEAD_FORM}\nfunction onSubmit() { fbq('track', 'Lead') }`
    )
    expect(result.state).toBe("undetermined")
    expect(result.findings[0]!.code).toBe("INF_SETUP_FORM_UNDETERMINED")
    expect(result.findings[0]!.message).toContain("do not assume either way")
  })

  it("never reads a field value — only tags and attribute names", () => {
    const result = check(
      "src/components/contact.tsx",
      LEAD_FORM.replace('name="company"', 'name="company" value="Acme Holdings Ltd" placeholder="Where do you work?"')
    )
    expect(result.findings[0]!.message).not.toContain("Acme")
    expect(result.findings[0]!.message).not.toContain("Where do you work")
    // Nor the form's own identifiers or action url, which classification reads but never emits.
    expect(result.findings[0]!.message).not.toContain("contact-form")
    expect(result.findings[0]!.message).not.toContain("/api/lead")
  })
})
