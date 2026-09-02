import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { detectHosting, detectHostingWithEvidence } from "./hosting.js"

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

  it("returns unknown when there is no package.json at all", () => {
    expect(detectHosting(fixture({ "index.html": "<html></html>" }))).toBe("unknown")
  })

  describe("vercel", () => {
    it("detects vercel.json", () => {
      expect(detectHosting(fixture({ "vercel.json": "{}" }))).toBe("vercel")
    })

    it("detects a linked .vercel/project.json", () => {
      expect(detectHosting(fixture({ ".vercel/project.json": '{"projectId":"p"}' }))).toBe("vercel")
    })

    it("detects an @vercel/* dependency", () => {
      expect(detectHosting(fixture({ "package.json": packageJson({ "@vercel/analytics": "^1.0.0" }) }))).toBe("vercel")
    })

    it("detects an @vercel/* devDependency", () => {
      expect(detectHosting(fixture({ "package.json": packageJson({}, { "@vercel/node": "^3.0.0" }) }))).toBe("vercel")
    })

    it("does not treat an unrelated dependency starting with 'vercel' as a signal", () => {
      expect(detectHosting(fixture({ "package.json": packageJson({ "vercelish-utils": "^1.0.0" }) }))).toBe("unknown")
    })
  })

  describe("netlify", () => {
    it("detects netlify.toml", () => {
      expect(detectHosting(fixture({ "netlify.toml": "[build]\n" }))).toBe("netlify")
    })

    it("detects a netlify/ directory", () => {
      expect(detectHosting(fixture({ "netlify/functions/hello.js": "export default () => {}\n" }))).toBe("netlify")
    })

    it("detects an @netlify/* dependency", () => {
      expect(detectHosting(fixture({ "package.json": packageJson({ "@netlify/functions": "^2.0.0" }) }))).toBe("netlify")
    })
  })

  describe("cloudflare", () => {
    it("detects wrangler.toml", () => {
      expect(detectHosting(fixture({ "wrangler.toml": 'name = "app"\n' }))).toBe("cloudflare")
    })

    it("detects wrangler.json / wrangler.jsonc", () => {
      expect(detectHosting(fixture({ "wrangler.json": "{}" }))).toBe("cloudflare")
      expect(detectHosting(fixture({ "wrangler.jsonc": "{}" }))).toBe("cloudflare")
    })

    it("detects a Pages functions/_middleware file", () => {
      expect(detectHosting(fixture({ "functions/_middleware.ts": "export const onRequest = () => {}\n" }))).toBe(
        "cloudflare"
      )
    })

    it("detects an @cloudflare/* dependency", () => {
      expect(detectHosting(fixture({ "package.json": packageJson({}, { "@cloudflare/workers-types": "^4.0.0" }) }))).toBe(
        "cloudflare"
      )
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

    it("vercel.json wins over wrangler.toml", () => {
      expect(detectHosting(fixture({ "vercel.json": "{}", "wrangler.toml": 'name = "app"\n' }))).toBe("vercel")
    })

    it("vercel.json wins over an express dependency", () => {
      expect(
        detectHosting(fixture({ "vercel.json": "{}", "package.json": packageJson({ express: "^4.19.2" }) }))
      ).toBe("vercel")
    })

    it("netlify.toml beats a bare @vercel/* dependency (no vercel.json)", () => {
      expect(
        detectHosting(
          fixture({ "netlify.toml": "[build]\n", "package.json": packageJson({ "@vercel/analytics": "^1.0.0" }) })
        )
      ).toBe("netlify")
    })

    it("wrangler.toml beats a bare @vercel/* dependency (no vercel.json)", () => {
      expect(
        detectHosting(
          fixture({ "wrangler.toml": 'name = "app"\n', "package.json": packageJson({ "@vercel/analytics": "^1.0.0" }) })
        )
      ).toBe("cloudflare")
    })

    it("a linked .vercel/project.json beats an express dependency", () => {
      expect(
        detectHosting(
          fixture({ ".vercel/project.json": '{"projectId":"p"}', "package.json": packageJson({ express: "^4.19.2" }) })
        )
      ).toBe("vercel")
    })

    it("netlify beats cloudflare when both are only dependency signals", () => {
      expect(
        detectHosting(
          fixture({
            "package.json": packageJson({ "@netlify/functions": "^2.0.0", "@cloudflare/workers-types": "^4.0.0" })
          })
        )
      ).toBe("netlify")
    })
  })

  describe("evidence", () => {
    it("names the file or dependency that decided it", () => {
      expect(detectHostingWithEvidence(fixture({ "vercel.json": "{}" }))).toEqual({
        hosting: "vercel",
        evidence: "vercel.json"
      })
      expect(
        detectHostingWithEvidence(fixture({ "package.json": packageJson({ express: "^4.19.2" }) }))
      ).toEqual({ hosting: "node", evidence: 'the "express" dependency' })
      expect(detectHostingWithEvidence(fixture({ "functions/_middleware.ts": "" }))).toEqual({
        hosting: "cloudflare",
        evidence: "functions/_middleware.ts"
      })
      expect(detectHostingWithEvidence(fixture({ "index.html": "" }))).toEqual({
        hosting: "unknown",
        evidence: null
      })
    })
  })
})
