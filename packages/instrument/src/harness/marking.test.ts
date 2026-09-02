import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  CONVERSIONS_MANIFEST_RELATIVE_PATH,
  PROPOSED_CONVERSIONS_RELATIVE_PATH,
  applyConversions,
  ensureProposedIgnored,
  proposeConversions,
  readApprovedConversions,
  unmarkConversions,
  writeProposal
} from "./marking.js"

const tempRoots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-marking-"))
  tempRoots.push(root)
  return root
}

function write(root: string, relativePath: string, contents: string): void {
  mkdirSync(dirname(join(root, relativePath)), { recursive: true })
  writeFileSync(join(root, relativePath), contents)
}

function read(root: string, relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8")
}

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

const PAGE_TSX = `import Link from "next/link"

export default function Page() {
  return (
    <main>
      <header>
        <nav>
          <Link href="/pricing">Pricing</Link>
        </nav>
      </header>
      <section>
        <a href="/signup" className="btn">Start free trial</a>
        <button onClick={() => open()}>Book a demo</button>
        <a href="/download">Download the app</a>
        <a href="https://buy.stripe.com/abc123">Buy now</a>
        <a href="/faq" data-analytics-cta-id="faq_link">FAQ</a>
        <a href="/join" data-conversion="signup">Join</a>
        <a href="#">Top</a>
      </section>
    </main>
  )
}
`

const INDEX_HTML = `<!doctype html>
<html>
  <body>
    <footer>
      <a href="mailto:hi@example.com">Email us</a>
      <button type="submit">Send</button>
    </footer>
  </body>
</html>
`

describe("proposeConversions", () => {
  it("proposes anchors and buttons with evidence and skips the runtime's special cases", () => {
    const root = makeRoot()
    write(root, "app/page.tsx", PAGE_TSX)
    write(root, "index.html", INDEX_HTML)
    write(root, "node_modules/x/index.html", INDEX_HTML)

    const proposal = proposeConversions({ root, appRoot: "." })
    expect(proposal.rows.map((row) => [row.ctaId, row.file, row.line, row.tag, row.ctaLocation])).toEqual([
      ["pricing", "app/page.tsx", 8, "a", "nav"],
      ["start_free_trial", "app/page.tsx", 12, "a", "main"],
      ["book_a_demo", "app/page.tsx", 13, "button", "main"],
      ["email_us", "index.html", 5, "a", "footer"],
      ["send", "index.html", 6, "button", "footer"]
    ])
    const trial = proposal.rows[1]
    expect(trial.hrefOrHandler).toBe("/signup")
    expect(trial.textSnippet).toBe("Start free trial")
    expect(trial.lineHash).toMatch(/^[a-f0-9]{64}$/)
    expect(proposal.skipped.map((entry) => [entry.line, entry.reason])).toEqual([
      [14, "download destination (the runtime already counts it)"],
      [15, "Stripe host (the runtime already counts it)"],
      [16, "already marked (data-analytics-cta-id)"],
      [17, "already marked (data-conversion)"],
      [18, "no destination"]
    ])
  })

  it("keeps cta ids unique tokens and honours a custom download destination", () => {
    const root = makeRoot()
    write(root, "index.html", `<a href="/x">Go!</a>\n<a href="/y">Go!</a>\n<a href="/get-app">Get</a>\n<a href="/z">  </a>\n`)
    const proposal = proposeConversions({ root, appRoot: ".", downloadDestinationPath: "/get-app" })
    expect(proposal.rows.map((row) => row.ctaId)).toEqual(["go", "go_2", "z"])
    for (const row of proposal.rows) expect(row.ctaId).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(proposal.skipped[0]).toMatchObject({ line: 3, reason: "download destination (the runtime already counts it)" })
  })

  it("writes the proposal locally and gitignores it inside a fenced block", () => {
    const root = makeRoot()
    write(root, "index.html", INDEX_HTML)
    write(root, ".gitignore", "node_modules\n")
    const proposal = proposeConversions({ root, appRoot: "." })
    const path = writeProposal(root, proposal)
    expect(path.endsWith(PROPOSED_CONVERSIONS_RELATIVE_PATH)).toBe(true)
    expect(JSON.parse(read(root, PROPOSED_CONVERSIONS_RELATIVE_PATH)).rows).toHaveLength(2)

    const change = ensureProposedIgnored(root)
    expect(change).toBe("appended")
    const ignore = read(root, ".gitignore")
    expect(ignore).toContain("node_modules\n")
    expect(ignore).toContain("# infinite:start")
    expect(ignore).toContain(PROPOSED_CONVERSIONS_RELATIVE_PATH)
    expect(ignore).toContain("# infinite:end")
    expect(ensureProposedIgnored(root)).toBe("present")
  })
})

describe("applyConversions", () => {
  it("adds only the two data attributes on the exact element, records the manifest, and is idempotent", () => {
    const root = makeRoot()
    write(root, "app/page.tsx", PAGE_TSX)
    const proposal = proposeConversions({ root, appRoot: "." })
    const approved = { rows: proposal.rows.filter((row) => row.ctaId !== "book_a_demo") }

    const result = applyConversions({ root, appRoot: ".", approved })
    expect(result.marked.map((row) => row.ctaId)).toEqual(["pricing", "start_free_trial"])
    expect(result.stale).toEqual([])

    const after = read(root, "app/page.tsx")
    const before = PAGE_TSX.split("\n")
    const lines = after.split("\n")
    expect(lines[7]).toBe(`          <Link data-analytics-cta-id="pricing" data-analytics-cta-location="nav" href="/pricing">Pricing</Link>`)
    expect(lines[11]).toBe(`        <a data-analytics-cta-id="start_free_trial" data-analytics-cta-location="main" href="/signup" className="btn">Start free trial</a>`)
    // Every other byte is untouched.
    for (const [index, line] of before.entries()) {
      if (index !== 7 && index !== 11) expect(lines[index]).toBe(line)
    }

    const manifest = JSON.parse(read(root, CONVERSIONS_MANIFEST_RELATIVE_PATH))
    expect(manifest.marked).toHaveLength(2)
    expect(manifest.marked[0]).toMatchObject({ file: "app/page.tsx", line: 8, ctaId: "pricing" })
    expect(manifest.marked[0].beforeHash).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.marked[0].afterHash).toMatch(/^[a-f0-9]{64}$/)

    // Re-running with the same approval is a no-op: the element is already marked.
    const again = applyConversions({ root, appRoot: ".", approved })
    expect(again.marked).toEqual([])
    expect(again.skipped.map((entry) => entry.reason)).toEqual(["already marked", "already marked"])
    expect(read(root, "app/page.tsx")).toBe(after)
  })

  it("refuses a stale element with INF_MARK_STALE_ELEMENT and still marks the others", () => {
    const root = makeRoot()
    write(root, "app/page.tsx", PAGE_TSX)
    const proposal = proposeConversions({ root, appRoot: "." })
    write(root, "app/page.tsx", PAGE_TSX.replace('<a href="/signup" className="btn">', '<a href="/register" className="btn">'))

    const result = applyConversions({ root, appRoot: ".", approved: { rows: proposal.rows.slice(0, 3) } })
    expect(result.stale).toEqual([
      expect.objectContaining({
        file: "app/page.tsx",
        line: 12,
        code: "INF_MARK_STALE_ELEMENT",
        message: "Could not mark app/page.tsx:12 — the element changed since it was proposed. Re-run infinite analytics --plan to re-propose."
      })
    ])
    expect(result.marked.map((row) => row.ctaId)).toEqual(["pricing", "book_a_demo"])
    expect(read(root, "app/page.tsx")).toContain('<a href="/register" className="btn">')
  })
})

describe("readApprovedConversions", () => {
  it("accepts the proposed file's shape and rejects a bad token", () => {
    const root = makeRoot()
    write(root, "index.html", INDEX_HTML)
    const proposal = proposeConversions({ root, appRoot: "." })
    writeProposal(root, proposal)
    const approved = readApprovedConversions(root, PROPOSED_CONVERSIONS_RELATIVE_PATH)
    expect(approved.rows).toHaveLength(2)

    write(root, "bad.json", JSON.stringify({ rows: [{ ...proposal.rows[0], ctaId: "has space" }] }))
    expect(() => readApprovedConversions(root, "bad.json")).toThrow(/ctaId/)
    write(root, "bad2.json", JSON.stringify({ rows: [{ ctaId: "ok", file: "index.html", line: 5 }] }))
    expect(() => readApprovedConversions(root, "bad2.json")).toThrow(/lineHash/)
  })
})

describe("unmarkConversions", () => {
  it("restores the original bytes and removes the manifest", () => {
    const root = makeRoot()
    write(root, "index.html", INDEX_HTML)
    const proposal = proposeConversions({ root, appRoot: "." })
    applyConversions({ root, appRoot: ".", approved: { rows: proposal.rows } })
    expect(read(root, "index.html")).not.toBe(INDEX_HTML)

    const result = unmarkConversions(root)
    expect(result.restored).toHaveLength(2)
    expect(read(root, "index.html")).toBe(INDEX_HTML)
    expect(existsSync(join(root, CONVERSIONS_MANIFEST_RELATIVE_PATH))).toBe(false)
  })
})
