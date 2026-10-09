import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { detectHosting } from "./hosting.js"

const tempRoots: string[] = []

/** Build a throwaway app root from a { relativePath: contents } map. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "instrument-hosting-"))
  tempRoots.push(root)
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath)
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, contents)
  }
  return root
}

function packageJson(dependencies: Record<string, string>, dev: Record<string, string> = {}): string {
  return JSON.stringify({ name: "fixture", dependencies, devDependencies: dev }, null, 2)
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe("detectHosting", () => {
  it("returns unknown for a bare project with no hosting signal", () => {
    expect(detectHosting(fixture({ "package.json": packageJson({ react: "^19.0.0" }) }))).toBe("unknown")
  })

  describe("vercel", () => {
    it("detects vercel.json", () => {
      expect(detectHosting(fixture({ "vercel.json": "{}" }))).toBe("vercel")
    })

    it("does not treat an unrelated dependency starting with 'vercel' as a signal", () => {
      expect(detectHosting(fixture({ "package.json": packageJson({ "vercelish-utils": "^1.0.0" }) }))).toBe("unknown")
    })
  })

  describe("netlify", () => {
    it("detects netlify.toml", () => {
      expect(detectHosting(fixture({ "netlify.toml": "[build]\n" }))).toBe("netlify")
    })
  })

  describe("cloudflare", () => {
    it("detects wrangler.toml", () => {
      expect(detectHosting(fixture({ "wrangler.toml": 'name = "app"\n' }))).toBe("cloudflare")
    })

    it("does not treat a bare functions/ directory without _middleware as Cloudflare", () => {
      expect(detectHosting(fixture({ "functions/hello.ts": "export const onRequest = () => {}\n" }))).toBe("unknown")
    })
  })

  describe("node", () => {
    it("detects an express dependency", () => {
      expect(detectHosting(fixture({ "package.json": packageJson({ express: "^4.19.2" }) }))).toBe("node")
    })
  })

  describe("ties", () => {
    it("vercel.json wins over netlify.toml", () => {
      expect(detectHosting(fixture({ "vercel.json": "{}", "netlify.toml": "[build]\n" }))).toBe("vercel")
    })

    it("netlify.toml beats a bare @vercel/* dependency (no vercel.json)", () => {
      expect(
        detectHosting(
          fixture({ "netlify.toml": "[build]\n", "package.json": packageJson({ "@vercel/analytics": "^1.0.0" }) })
        )
      ).toBe("netlify")
    })
  })
})
