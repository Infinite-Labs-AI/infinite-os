import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const srcDir = dirname(fileURLToPath(import.meta.url))
const packageJsonPath = join(srcDir, "../package.json")

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>
}

function collectTsFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full))
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      results.push(full)
    }
  }
  return results
}

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const lines = source.split("\n")
  // Match lines that are import/export-from statements:
  //   import ... from "X"
  //   export ... from "X"
  //   import "X"  (side-effect)
  const fromRe = /^(?:import|export)\b.*\bfrom\s+["']([^"']+)["']/
  const sideEffectRe = /^import\s+["']([^"']+)["']/
  for (const line of lines) {
    const trimmed = line.trim()
    const fromMatch = fromRe.exec(trimmed)
    if (fromMatch) {
      specifiers.push(fromMatch[1])
      continue
    }
    const sideMatch = sideEffectRe.exec(trimmed)
    if (sideMatch) {
      specifiers.push(sideMatch[1])
    }
  }
  return specifiers
}

describe("package.json shape", () => {
  it("has no runtime dependency keys", () => {
    const pkg = readJson(packageJsonPath)
    const forbidden = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    for (const key of forbidden) {
      expect(pkg, `package.json must not have a "${key}" key`).not.toHaveProperty(key)
    }
  })

  it('files includes only runtime output and public contracts', () => {
    const pkg = readJson(packageJsonPath)
    expect(pkg["files"]).toEqual(["dist/src", "contracts"])
  })

  it('bin["infinite-tag"] uses npm 11 normalized relative syntax', () => {
    const pkg = readJson(packageJsonPath)
    const bin = pkg["bin"] as Record<string, string>
    expect(bin["infinite-tag"]).toBe("dist/src/cli.js")
  })

  it("scripts.prepack runs a clean build (covers both npm pack and npm publish)", () => {
    const pkg = readJson(packageJsonPath)
    const scripts = pkg["scripts"] as Record<string, string>
    // prepack (not prepublishOnly) so a dev-built dist with compiled tests can
    // never leak into the tarball: npm pack skips prepublishOnly but runs prepack.
    expect(scripts["prepack"]).toContain("rm -rf dist")
    expect(scripts["prepack"]).toContain("tsconfig.build.json")
  })

  it("postinstall explains that package install is not instrumentation yet, and points at the wizard", () => {
    const pkg = readJson(packageJsonPath)
    const scripts = pkg["scripts"] as Record<string, string>
    expect(scripts["postinstall"]).toEqual(expect.any(String))
    expect(scripts["postinstall"]).toContain("infinite-tag installed")
    expect(scripts["postinstall"]).toContain("Next: run npx infinite-tag in your website repo.")
    expect(scripts["postinstall"]).toContain("Package install alone does not wire analytics.")
    // The wizard needs no workspace id: the old `install --workspace <workspace-id>` pointer is gone.
    expect(scripts["postinstall"]).not.toContain("--workspace")
  })

  it('exports["."] starts with "./dist/"', () => {
    const pkg = readJson(packageJsonPath)
    const exports = pkg["exports"] as Record<string, string>
    expect(exports["."]).toMatch(/^\.\/dist\//)
  })
})

describe("LICENSE (npm always packs it)", () => {
  const license = readFileSync(join(srcDir, "../LICENSE"), "utf8")

  it("carries PostHog's full MIT notice for the PostHog-derived wizard patterns", () => {
    expect(license).toContain("Copyright (c) 2025 PostHog")
    expect(license).toContain("Permission is hereby granted, free of charge")
    expect(license).toContain("PostHog wizard (v2.74.1")
  })

  it("still starts with infinite-tag's own MIT licence", () => {
    expect(license.startsWith("MIT License\n\nCopyright (c) 2025-2026 Ultima AI, Inc\n")).toBe(true)
    // Two notices, each with its permission text: the first is ours, the second PostHog's.
    expect(license.split("Permission is hereby granted").length - 1).toBe(2)
  })
})

describe("source self-containment", () => {
  it("every import in src/ is node:, relative, or vitest (test files only)", () => {
    const tsFiles = collectTsFiles(srcDir)
    const violations: string[] = []

    for (const file of tsFiles) {
      const isTestFile = file.endsWith(".test.ts")
      const source = readFileSync(file, "utf8")
      const specifiers = extractImportSpecifiers(source)

      for (const spec of specifiers) {
        if (spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../")) {
          continue
        }
        if (spec === "vitest" && isTestFile) {
          continue
        }
        violations.push(`${file}: "${spec}"`)
      }
    }

    expect(violations, `External imports found:\n${violations.join("\n")}`).toEqual([])
  })
})
