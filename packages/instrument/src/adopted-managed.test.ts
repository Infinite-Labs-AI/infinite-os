// Managed code that serves ADOPTED tools, through the REAL plan + apply path (adopted detection
// included), executed in the vm browser.
//
//   - P1-2: the conversion helpers (decisions 9 and 13) are written even when every requested tool was
//     adopted (the commonest wizard customer already has GA4 + PostHog + Meta). Without them job 9's
//     `import { infiniteTrack } from "@/lib/infinite-analytics"` fails the build, and on a static site
//     every wired click throws on `window.infiniteTrack`.
//   - P1-3: Meta `captureOnly` adds the `_fbc` capture beside an ADOPTED pixel and never touches the pixel;
//     without a pixel on the site it is a blocker, never a plan that claims a pixel that is not there.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { createBrowserVm, decodeNextBootstrap } from "../test/site-code/browser-vm.js"
import { cleanupFixtures, installFixture, planFixture } from "../test/site-code/install-fixture.js"

afterAll(cleanupFixtures)

const ADOPTED_GA4 = '<script async src="https://www.googletagmanager.com/gtag/js?id=G-ADOPT1"></script>'
const ADOPTED_PIXEL = "6543210987654321"
const ADOPTED_META = [
  "<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};",
  "if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;",
  "s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window, document,'script','https://connect.facebook.net/en_US/fbevents.js');",
  `fbq('init', '${ADOPTED_PIXEL}');fbq('track', 'PageView');</script>`
].join("")

function pasteIntoHtmlHead(snippet: string) {
  return (root: string) => {
    const file = join(root, "index.html")
    writeFileSync(file, readFileSync(file, "utf8").replace("</head>", `${snippet}\n</head>`))
  }
}

function pasteIntoNextLayout(snippet: string) {
  return (root: string) => {
    const file = join(root, "app/layout.tsx")
    writeFileSync(file, readFileSync(file, "utf8").replace("<body>", `<head>${snippet}</head>\n      <body>`))
  }
}

describe("P1-2: the helpers are written when every requested tool is ADOPTED", () => {
  it("Next: the managed module is created with the helpers and the layout is wired", () => {
    const site = installFixture(
      "next-app-router-basic",
      { ga4: { measurementId: "G-ADOPT1" }, conversions: { helpers: true } },
      pasteIntoNextLayout(ADOPTED_GA4)
    )
    expect(site.plan.adopted.map((entry) => entry.provider)).toEqual(["ga4"])
    expect(site.plan.providers).toEqual([])
    expect(site.exists("lib/infinite-analytics.ts")).toBe(true)
    const managedModule = site.read("lib/infinite-analytics.ts")
    expect(managedModule).toMatch(/export function infiniteTrack\(/)
    expect(site.read("app/layout.tsx")).toContain("InfiniteAnalyticsClient")
    // The adopted GA4 is untouched, and the bootstrap starts no tool of its own.
    expect(site.read("app/layout.tsx")).toContain(ADOPTED_GA4)
    const vm = createBrowserVm({ url: "https://acme.com/" })
    vm.runScript(decodeNextBootstrap(managedModule))
    expect(vm.scriptErrors).toEqual([])
    expect(typeof vm.window.infiniteTrack).toBe("function")
    expect(vm.loaded).toEqual([])
  })

  it("static: the managed block carries the helper globals, and the page's own calls reach them", () => {
    const site = installFixture(
      "static-html-basic",
      { ga4: { measurementId: "G-ADOPT1" }, conversions: { helpers: true } },
      pasteIntoHtmlHead(ADOPTED_GA4)
    )
    expect(site.plan.providers).toEqual([])
    const vm = createBrowserVm({ url: "https://acme.com/" })
    vm.runHtml(site.read("index.html"))
    expect(vm.scriptErrors).toEqual([])
    expect(typeof vm.window.infiniteTrack).toBe("function")
    expect(typeof vm.window.infiniteTrackThenNavigate).toBe("function")
  })

  it("negative: without the helpers an all-adopted plan still writes nothing at all", () => {
    const site = installFixture("static-html-basic", { ga4: { measurementId: "G-ADOPT1" } }, pasteIntoHtmlHead(ADOPTED_GA4))
    expect(site.warnings.join("\n")).toMatch(/Nothing to install/)
    expect(site.read("index.html")).not.toContain("infinite")
    expect(site.exists(".infinite/install.json")).toBe(false)
  })
})

describe("P1-3: Meta captureOnly beside an ADOPTED pixel", () => {
  const artifacts = { meta: { pixelId: ADOPTED_PIXEL, captureOnly: true } }

  it("adds the _fbc capture and leaves the adopted pixel byte-for-byte alone", () => {
    const site = installFixture("static-html-basic", artifacts, pasteIntoHtmlHead(ADOPTED_META))
    expect(site.plan.adopted.map((entry) => entry.provider)).toEqual(["meta"])
    expect(site.plan.providers).toEqual([]) // the manifest never claims the customer's pixel
    const html = site.read("index.html")
    expect(html).toContain(ADOPTED_META)
    expect(html.match(/fbevents\.js/g)).toHaveLength(1) // no second pixel
    const vm = createBrowserVm({ url: "https://acme.com/?fbclid=Adopted_Click" })
    vm.runHtml(html)
    expect(vm.scriptErrors).toEqual([])
    expect(vm.cookies.values("_fbc")).toHaveLength(1)
    expect(vm.evaluate("infiniteMetaClickId()")).toMatch(/^fb\.\d\.\d+\.Adopted_Click$/)
  })

  it("negative: without a pixel on the site captureOnly is a blocker, never a plan that claims one", () => {
    const plan = planFixture("static-html-basic", artifacts)
    expect(plan.blockers.join("\n")).toMatch(/captureOnly\) needs the site's existing Meta pixel/)
    expect(plan.assumptions.join("\n")).not.toMatch(/existing pixel/)
    expect(plan.instructions.filter((instruction) => instruction.provider === "meta")).toEqual([])
  })
})
