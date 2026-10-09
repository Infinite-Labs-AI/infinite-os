// The preview guard, executed. Ported from infinite-site `.github/scripts/test-inject-analytics.mjs`
// L694-710 @ 9f65b47 (a preview host loads nothing; a production host with a trailing dot still
// starts), generalised to the deny mode customers get (decision 3) and the 13-host matrix from the
// build plan (§1.1, S5). Every case runs the EMITTED expression in node:vm and its TS twin, and the two
// must agree.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import ts from "typescript"

import { createBrowserVm } from "../test/site-code/browser-vm.js"

import {
  buildHostGuardExpression,
  guardHostLiteral,
  hostGuardAllows,
  normalizeHostGuardSpec,
  resolveArtifactHostGuard,
  wrapGuardedSnippet,
  type HostGuardSpec
} from "./host-guard.js"

const GUARD: HostGuardSpec = {
  mode: "deny",
  exempt: ["acme.com", "www.acme.com", "acme-git-main-x.vercel.app"],
  deny: []
}

it("emits a guard accepted by strict TypeScript and by the adopted-init checker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "infinite-guard-ts-"))
  try {
    const source = `declare const fbq: (...args: string[]) => void\nexport function start() {\n  if (!(${buildHostGuardExpression(GUARD)})) return\n  fbq('init', '111222333444555')\n}\n`
    const path = join(dir, "tracking.ts")
    writeFileSync(path, source)
    const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2020, skipLibCheck: true }
    const program = ts.createProgram([path], options)
    expect(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
    const { checkHostGuard } = await import("./setup-checks/host-guard.js")
    expect(checkHostGuard({ files: new Map([["tracking.ts", source]]), strict: true, expectedEmittedGuard: buildHostGuardExpression(GUARD) }).state).toBe("ok")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

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
  it("exempt wins over every deny rule: production is never silenced (decision 3)", () => {
    const spec: HostGuardSpec = { mode: "deny", exempt: ["acme.vercel.app"], deny: ["acme.vercel.app"] }
    expect(firesInBrowser("acme.vercel.app", spec)).toBe(true)
    expect(firesInBrowser("acme-pr-9.vercel.app", spec)).toBe(false)
  })

  it("negative: without the exempt list the production *.vercel.app alias goes dark", () => {
    const spec: HostGuardSpec = { mode: "deny", exempt: ["acme.com"], deny: [] }
    expect(firesInBrowser("acme-git-main-x.vercel.app", spec)).toBe(false)
  })
})

describe("the allow-mode guard (infinite.fast parity)", () => {
  it("negative: an allow guard with no hosts fires nowhere", () => {
    const spec: HostGuardSpec = { mode: "allow", hosts: [] }
    for (const [host] of MATRIX) {
      expect(firesInBrowser(host, spec)).toBe(false)
      expect(hostGuardAllows(host, spec)).toBe(false)
    }
  })
})

describe("wrapGuardedSnippet", () => {
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
  it("P3-1: resolveArtifactHostGuard refuses a deny literal on a production host, from either production list", () => {
    const guard = { mode: "deny" as const, exempt: [] as string[], deny: ["shop.acme.com"] }
    expect(resolveArtifactHostGuard({ productionHosts: ["shop.acme.com"], hostGuard: guard }).error).toMatch(/shop\.acme\.com/)
    expect(
      resolveArtifactHostGuard({ infinite: { productionHosts: ["acme.vercel.app"] }, hostGuard: { ...guard, deny: [] } }).error
    ).toMatch(/acme\.vercel\.app/)
    expect(resolveArtifactHostGuard({ productionHosts: ["acme.com"], hostGuard: guard }).spec).toBeDefined()
  })
})
