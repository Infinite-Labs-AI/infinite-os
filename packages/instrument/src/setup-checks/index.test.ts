import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { runSetupChecks, setupChecksNote, setupFindingLines } from "./index.js"

const roots: string[] = []

function makeApp(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "setup-checks-"))
  roots.push(root)
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), contents)
  }
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

/** All three defects in one app — the night this feature exists for, reduced to a fixture. */
const BROKEN_APP = {
  "src/app/layout.tsx": "export default function Layout({ children }) { return <html><body>{children}</body></html> }",
  "src/components/lead-form.tsx": [
    "export function LeadForm() {",
    "  return (",
    '    <form action="/api/lead" method="post">',
    '      <input type="email" name="email" />',
    '      <button data-conversion="signup" type="submit">Get started</button>',
    "    </form>",
    "  )",
    "}"
  ].join("\n"),
  "src/components/contact.tsx": [
    '<form id="contact-form" action="/api/contact" method="post">',
    '  <input type="email" name="email" />',
    "  <button type=\"submit\">Talk to us</button>",
    "</form>"
  ].join("\n"),
  "src/app/thank-you/page.tsx": "<script>fbq('init', '555500001111222');fbq('track', 'PageView');</script>"
}

describe("runSetupChecks", () => {
  it("catches all three defects in one pass", () => {
    const report = runSetupChecks(makeApp(BROKEN_APP))
    expect(report.state).toBe("problem")
    expect(report.findings.map((finding) => finding.code).sort()).toEqual([
      "INF_SETUP_CLICK_ID_NOT_AT_LANDING",
      "INF_SETUP_CONVERSION_WRONG_ELEMENT",
      "INF_SETUP_FORM_NO_CONVERSION",
      // The site's own pixel starts on every host, previews included: a plan line (decision 8),
      // never an automatic edit, so it is information.
      "INF_SETUP_HOST_GUARD_MISSING",
      // The site's own pixel has Meta's automatic events on: information for a plan line, never a
      // problem and never an edit (founder decision 10).
      "INF_SETUP_META_AUTOCONFIG_ADOPTED_ON"
    ])
    expect(setupChecksNote(report)).toBe("3 setup problems, 0 undetermined, 2 worth checking")
    expect(setupFindingLines(report)).toHaveLength(5)
  })

  it("writes nothing into the app it inspects", () => {
    const root = makeApp(BROKEN_APP)
    const before = readdirSync(root).sort()
    runSetupChecks(root)
    expect(readdirSync(root).sort()).toEqual(before)
  })

  it("never returns a bare ok for an app it could not read", () => {
    const report = runSetupChecks(makeApp({ "src/app/page.tsx": "<main>Nothing here</main>" }))
    // No pixel in source: the click-id question is UNANSWERED, and the overall state says so.
    expect(report.state).toBe("undetermined")
    // Both Meta checks are unanswered, and both say so — in ONE next-step line, not two: a site that
    // may not use Meta at all is not told twice about a provider it never asked for.
    expect(report.checks.map((check) => [check.check, check.state])).toContainEqual(["meta_pixel_config", "undetermined"])
    expect(setupFindingLines(report).filter((line) => line.includes("fbq('init'"))).toHaveLength(1)
    expect(setupChecksNote(report)).toBe("0 setup problems, 1 undetermined, 0 worth checking")
  })
})
