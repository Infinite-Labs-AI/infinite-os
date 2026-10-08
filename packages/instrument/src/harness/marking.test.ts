import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  CONVERSIONS_MANIFEST_RELATIVE_PATH,
  applyConversions,
  detectServerCheckout,
  proposeConversions,
  renderServerCheckoutRecommendation,
  unmarkConversions
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

describe("applyConversions on a line with several candidates", () => {
  const ONE_LINE = `<nav><a href="/pricing">Pricing</a> <button onClick={go}>Buy now</button> <a href="/docs">Docs</a></nav>\n`

  it("records a column per element and marks ONLY the approved element", () => {
    const root = makeRoot()
    write(root, "index.html", ONE_LINE)
    const proposal = proposeConversions({ root, appRoot: "." })
    expect(proposal.rows.map((row) => [row.ctaId, row.column, row.tag])).toEqual([
      ["pricing", 5, "a"],
      ["buy_now", 36, "button"],
      ["docs", 74, "a"]
    ])
    const buyNow = proposal.rows.filter((row) => row.ctaId === "buy_now")
    const result = applyConversions({ root, appRoot: ".", approved: { rows: buyNow } })
    expect(result.stale).toEqual([])
    expect(result.marked.map((row) => [row.ctaId, row.column])).toEqual([["buy_now", 36]])
    expect(read(root, "index.html")).toBe(
      `<nav><a href="/pricing">Pricing</a> <button data-analytics-cta-id="buy_now" data-analytics-cta-location="nav" onClick={go}>Buy now</button> <a href="/docs">Docs</a></nav>\n`
    )
  })

  it("a row whose tag is no longer at its column is stale, not written onto a neighbour", () => {
    const root = makeRoot()
    write(root, "index.html", ONE_LINE)
    const proposal = proposeConversions({ root, appRoot: "." })
    const buyNow = { ...proposal.rows[1], column: 5 } // points at the anchor now
    const result = applyConversions({ root, appRoot: ".", approved: { rows: [buyNow] } })
    expect(result.marked).toEqual([])
    expect(result.stale).toHaveLength(1)
    expect(read(root, "index.html")).toBe(ONE_LINE)
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

describe("detectServerCheckout", () => {
  it("detects the server checkout entry and the verified webhook fulfillment as a pair", () => {
    const root = makeRoot()
    write(
      root,
      "pages/api/stripe-checkout.ts",
      "export default async function handler() {\n  const session = await stripe.checkout.sessions.create({ mode: 'payment' })\n  return session\n}\n"
    )
    write(
      root,
      "pages/api/stripe-webhook.ts",
      "export default function handler(req) {\n  const event = stripe.webhooks.constructEvent(req.body, sig, secret)\n  if (event.type === 'checkout.session.completed') fulfill(event)\n}\n"
    )
    const rec = detectServerCheckout({ root, appRoot: "." })
    expect(rec?.code).toBe("INF_CHECKOUT_SERVER_SIDE")
    expect(rec?.sessionCreate[0]).toMatchObject({
      kind: "session_create",
      file: "pages/api/stripe-checkout.ts",
      line: 2,
      evidence: "stripe.checkout.sessions.create"
    })
    expect(rec?.webhookFulfillment.some((signal) => signal.evidence === "stripe.webhooks.constructEvent")).toBe(true)

    const lines = renderServerCheckoutRecommendation(rec!)
    expect(lines.join("\n")).toContain("checkout_started")
    expect(lines.join("\n")).toContain("purchase")
    expect(lines.join("\n")).toContain("pages/api/stripe-checkout.ts:2")
  })
})
