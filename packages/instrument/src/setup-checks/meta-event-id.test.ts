// Meta event id + click-fired conversions (lane O9). Incident guarded: 22d08d4, phantom
// CompleteRegistrations from a page-built event id fired whatever the server said.
import { describe, expect, it } from "vitest"

import { buildManagedHtmlBlock } from "../frameworks/managed-html.js"

import { checkMetaEventId, findStandardOnClick } from "./meta-event-id.js"

const files = (record: Record<string, string>) => new Map(Object.entries(record))

describe("Meta event id", () => {
  it("flags an event id built in the page", () => {
    const code = "const id = `signup-${Date.now()}`\nfbq('track', 'CompleteRegistration', {}, { eventID: 'signup-' + user.id })"
    const result = checkMetaEventId({ files: files({ "app/signup/page.tsx": code }) })
    expect(result.findings.map((finding) => [finding.code, finding.state, finding.line])).toEqual([["INF_SETUP_META_EVENT_ID_PAGE_BUILT", "problem", 2]])
  })

  it("passes the server's metaEventId (negative)", () => {
    const code = "const { metaEventId } = await res.json()\nif (metaEventId) fbq('track', 'CompleteRegistration', {}, { eventID: metaEventId })"
    expect(checkMetaEventId({ files: files({ "app/signup/page.tsx": code }) }).findings).toEqual([])
  })

  it("says undetermined for an untraceable variable", () => {
    const result = checkMetaEventId({ files: files({ "app/lead.tsx": "fbq('track', 'Lead', {}, { eventID: leadId })" }) })
    expect(result.findings.map((finding) => finding.code)).toEqual(["INF_SETUP_META_EVENT_ID_UNDETERMINED"])
  })

  it("leaves server files and managed helpers alone", () => {
    const managed = `<html><head>${buildManagedHtmlBlock(["<script>fbq('track', 'Lead', {}, { eventID: 'x' + y })</script>"])}</head><body></body></html>`
    const result = checkMetaEventId({ files: files({ "app/api/lead/route.ts": "fbq('track','Lead',{},{eventID: crypto.randomUUID()})", "index.html": managed }) })
    expect(result.findings).toEqual([])
  })
})

describe("standard conversion on a click", () => {
  it("flags fbq('track', 'Lead') inside onClick and addEventListener('click')", () => {
    const jsx = "<button onClick={() => { fbq('track', 'Lead') }}>Talk to us</button>"
    const dom = "btn.addEventListener('click', function () {\n  fbq('track', 'Purchase', { value: 10 })\n})"
    const result = checkMetaEventId({ files: files({ "app/contact.tsx": jsx, "src/main.js": dom }) })
    expect(result.findings.map((finding) => [finding.file, finding.code])).toEqual([
      ["app/contact.tsx", "INF_SETUP_META_STANDARD_ON_CLICK"],
      ["src/main.js", "INF_SETUP_META_STANDARD_ON_CLICK"]
    ])
  })

  it("does not flag a funnel step on a click, or a conversion outside a handler (negatives)", () => {
    expect(findStandardOnClick("<button onClick={() => fbq('track', 'AddToCart')}>Add</button>")).toEqual([])
    expect(findStandardOnClick("btn.addEventListener('click', go)\nfbq('track', 'Lead')")).toEqual([])
    expect(findStandardOnClick('<a onclick="fbq(\'track\', \'Lead\')">x</a>').map((hit) => hit.event)).toEqual(["Lead"])
  })
})

describe("Meta event id: fallbacks, named handlers and non-Meta eventIDs (review P1-5, P2-8, P3-8)", () => {
  const codes = (code: string, file = "app/signup/page.tsx") => checkMetaEventId({ files: files({ [file]: code }) }).findings.map((finding) => finding.code)

  it("a fallback around metaEventId is page-built (22d08d4: the page fires with its own id when the server sends null)", () => {
    expect(codes("fbq('track', 'CompleteRegistration', {}, { eventID: res.metaEventId ?? crypto.randomUUID() })")).toEqual(["INF_SETUP_META_EVENT_ID_PAGE_BUILT"])
    expect(codes("fbq('track', 'CompleteRegistration', {}, { eventID: metaEventId || `signup-${Date.now()}` })")).toEqual(["INF_SETUP_META_EVENT_ID_PAGE_BUILT"])
    expect(codes("fbq('track', 'Lead', {}, { eventID: res.metaEventId ? res.metaEventId : makeId() })")).toEqual(["INF_SETUP_META_EVENT_ID_PAGE_BUILT"])
    // Negatives: the server's id itself, in its usual spellings.
    expect(codes("if (res?.metaEventId) fbq('track', 'Lead', {}, { eventID: res?.metaEventId })")).toEqual([])
    expect(codes("if (data.outcome.metaEventId) fbq('track', 'Lead', {}, { eventID: data.outcome.metaEventId! })")).toEqual([])
  })

  it("a conversion in a same-file named click handler is flagged", () => {
    expect(findStandardOnClick("function onBuy() {\n  fbq('track', 'Lead')\n}\nexport default () => <button onClick={onBuy}>Buy</button>").map((hit) => hit.event)).toEqual(["Lead"])
    expect(findStandardOnClick("const onBuy = () => fbq('track', 'Purchase')\nbtn.addEventListener('click', onBuy)").map((hit) => hit.event)).toEqual(["Purchase"])
    expect(findStandardOnClick("const go = async ({ id }) => {\n  await save(id)\n  fbq('track', 'Donate')\n}\n<button onClick={() => go({ id })}>Give</button>").map((hit) => hit.event)).toEqual(["Donate"])
    // Negative: a named function that is never a click handler.
    expect(findStandardOnClick("function onPaid() {\n  fbq('track', 'Purchase', {}, { eventID: metaEventId })\n}\nonPaid()")).toEqual([])
  })

  it("an eventID in a unit with no fbq call is not Meta's (a calendar event)", () => {
    expect(codes("const opts = { eventID: calendarEvent.id }", "app/calendar.tsx")).toEqual([])
    expect(codes("const opts = { eventID: 'cal-' + calendarEvent.id }", "app/calendar.tsx")).toEqual([])
  })
})
