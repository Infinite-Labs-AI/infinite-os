// The preview guard, executed. Ported from infinite-site `.github/scripts/test-inject-analytics.mjs`
// L694-710 @ 9f65b47 (a preview host loads nothing; a production host with a trailing dot still
// starts), generalised to the deny mode customers get (decision 3) and the 13-host matrix from the
// build plan (§1.1, S5). Every case runs the EMITTED expression in node:vm and its TS twin, and the two
// must agree.
import { describe, expect, it } from "vitest"

import { createBrowserVm } from "../test/site-code/browser-vm.js"

import {
  buildHostGuardExpression,
  classifyHost,
  guardHostLiteral,
  hostGuardAllows,
  normalizeHost,
  normalizeHostGuardSpec,
  productionDeniedConflict,
  wrapGuardedSnippet,
  type HostGuardSpec
} from "./host-guard.js"
import { HOST_DENY_V1 } from "./wizard/contracts/host-deny.js"

const GUARD: HostGuardSpec = {
  mode: "deny",
  exempt: ["acme.com", "www.acme.com", "acme-git-main-x.vercel.app"],
  deny: []
}

// host → fires?  (label explains the row)
const MATRIX: Array<[string, boolean, string]> = [
  ["acme.com", true, "production"],
  ["ACME.com.", true, "production, any case, one trailing dot"],
  ["www.acme.com", true, "exempt"],
  ["acme-git-main-x.vercel.app", true, "the production *.vercel.app alias, exempt literal"],
  ["acme-abc123.vercel.app", false, "a Vercel preview"],
  ["localhost", false, "loopback"],
  ["127.0.0.1", false, "loopback"],
  ["0.0.0.0", false, "unspecified address"],
  ["foo.local", false, ".local"],
  ["x.netlify.app", false, "a Netlify preview"],
  ["x.pages.dev", false, "a Cloudflare Pages preview"],
  ["staging.acme.com", true, "leaks: deny-list (unknown hosts fail open)"],
  ["other.example", true, "unknown, let through"]
]

function firesInBrowser(hostname: string, spec: HostGuardSpec): boolean {
  // The emitted expression reads location.hostname; a URL cannot carry "ACME.com." verbatim, so the
  // vm's location is overwritten with the raw value a browser would report.
  const vm = createBrowserVm({ url: "https://placeholder.test/" })
  ;(vm.window.location as { hostname: string }).hostname = hostname
  return vm.evaluate<boolean>(buildHostGuardExpression(spec)) === true
}

describe("the deny-mode guard (customer default), executed", () => {
  it.each(MATRIX)("%s → fires=%s (%s)", (host, fires) => {
    expect(firesInBrowser(host, GUARD)).toBe(fires)
    expect(hostGuardAllows(host, GUARD)).toBe(fires)
  })

  it("labels staging.acme.com as 'allowed' (a known leak) and the preview as 'denied'", () => {
    expect(classifyHost("staging.acme.com", GUARD as { exempt: string[]; deny: string[] })).toBe("allowed")
    expect(classifyHost("acme-abc123.vercel.app", GUARD as { exempt: string[]; deny: string[] })).toBe("denied")
    expect(classifyHost("ACME.com.", GUARD as { exempt: string[]; deny: string[] })).toBe("exempt")
  })

  it("exempt wins over every deny rule: production is never silenced (decision 3)", () => {
    const spec: HostGuardSpec = { mode: "deny", exempt: ["acme.vercel.app"], deny: ["acme.vercel.app"] }
    expect(firesInBrowser("acme.vercel.app", spec)).toBe(true)
    expect(firesInBrowser("acme-pr-9.vercel.app", spec)).toBe(false)
  })

  it("extra deny literals (preview hosts Vercel reported) are silent too", () => {
    const spec: HostGuardSpec = { mode: "deny", exempt: ["acme.com"], deny: ["preview.acme.com"] }
    expect(firesInBrowser("preview.acme.com", spec)).toBe(false)
    expect(firesInBrowser("PREVIEW.acme.com.", spec)).toBe(false)
    expect(firesInBrowser("acme.com", spec)).toBe(true)
  })

  it("reads the deny list from F0's contract, never a hand copy", () => {
    const source = buildHostGuardExpression(GUARD)
    for (const value of [...HOST_DENY_V1.deny.exact, ...HOST_DENY_V1.deny.suffix]) {
      expect(source).toContain(JSON.stringify(value))
    }
  })

  it("negative: without the exempt list the production *.vercel.app alias goes dark", () => {
    const spec: HostGuardSpec = { mode: "deny", exempt: ["acme.com"], deny: [] }
    expect(firesInBrowser("acme-git-main-x.vercel.app", spec)).toBe(false)
  })
})

describe("the allow-mode guard (infinite.fast parity)", () => {
  it("fires only on the listed hosts, trailing dot ignored", () => {
    const spec: HostGuardSpec = { mode: "allow", hosts: ["acme.com"] }
    expect(firesInBrowser("acme.com", spec)).toBe(true)
    expect(firesInBrowser("Acme.Com.", spec)).toBe(true)
    expect(firesInBrowser("staging.acme.com", spec)).toBe(false)
    expect(firesInBrowser("other.example", spec)).toBe(false)
  })

  it("negative: an allow guard with no hosts fires nowhere", () => {
    const spec: HostGuardSpec = { mode: "allow", hosts: [] }
    for (const [host] of MATRIX) {
      expect(firesInBrowser(host, spec)).toBe(false)
      expect(hostGuardAllows(host, spec)).toBe(false)
    }
  })
})

describe("wrapGuardedSnippet", () => {
  it("is one IIFE: the guard's return stops only its own snippet", () => {
    const vm = createBrowserVm({ url: "https://acme-abc123.vercel.app/" })
    vm.runScript(
      [wrapGuardedSnippet("window.guarded = true;", GUARD), "window.afterwards = true;"].join("\n")
    )
    expect(vm.scriptErrors).toEqual([])
    expect(vm.window.guarded).toBeUndefined()
    expect(vm.window.afterwards).toBe(true)
  })

  it("negative: the same guard as a bare top-level return is a SyntaxError that stops everything", () => {
    const vm = createBrowserVm({ url: "https://acme-abc123.vercel.app/" })
    vm.runScript([`if (!(${buildHostGuardExpression(GUARD)})) return;`, "window.afterwards = true;"].join("\n"))
    expect(vm.scriptErrors).toHaveLength(1)
    expect(vm.scriptErrors[0]!.name).toBe("SyntaxError")
    expect(vm.window.afterwards).toBeUndefined()
  })

  it("emits no backtick, no ${ and no </ so it folds into <script> and the Next string literal", () => {
    const source = wrapGuardedSnippet("x();", GUARD) + buildHostGuardExpression({ mode: "allow", hosts: [] })
    expect(source).not.toMatch(/`|\$\{|<\//)
  })
})

describe("one normaliser", () => {
  it("acme.com. ≡ ACME.com ≡ ' acme.com '", () => {
    expect(normalizeHost("acme.com.")).toBe("acme.com")
    expect(normalizeHost("ACME.com")).toBe("acme.com")
    expect(normalizeHost(" acme.com ")).toBe("acme.com")
    // ONE trailing dot only.
    expect(normalizeHost("acme.com..")).toBe("acme.com.")
  })

  it("normalises and de-duplicates a spec, and refuses a value that is not a hostname", () => {
    expect(normalizeHostGuardSpec({ mode: "deny", exempt: ["WWW.acme.com.", "www.acme.com"], deny: [] })).toEqual({
      mode: "deny",
      exempt: ["www.acme.com"],
      deny: []
    })
    expect(guardHostLiteral("[::1]")).toBe("[::1]")
    for (const bad of ["", "acme.com/path", "https://acme.com", "a..b", "acme.com:443", '"];alert(1);//']) {
      expect(() => guardHostLiteral(bad)).toThrow(/not a hostname/)
    }
  })
})

describe("productionDeniedConflict", () => {
  it("names the observed production host a deny rule would silence", () => {
    expect(productionDeniedConflict(["acme.vercel.app"], [])).toEqual(["acme.vercel.app"])
    expect(productionDeniedConflict(["acme.vercel.app"], ["acme.vercel.app"])).toEqual([])
  })

  it("normalises both sides and ignores hosts no rule denies", () => {
    expect(productionDeniedConflict(["ACME.vercel.app.", "acme.com", "localhost"], ["acme.vercel.app"])).toEqual([
      "localhost"
    ])
    expect(productionDeniedConflict(["acme.com", "www.acme.com"], [])).toEqual([])
  })
})
