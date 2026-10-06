// The capture job's plain-module proof. Only a top-level statement immediately after the import/directive
// preamble can run when the module loads. Compare statement lines, preserving everything except indentation
// and CRLF, then hand T0 the SITE fragment with its TypeScript annotations removed.
import { buildMetaClickIdCaptureJavascript, buildMetaClickIdCaptureTypescript } from "../providers/meta-browser/click-id.js"
import { lexicalStates } from "../lexical-states.js"

export interface ExecutableModuleCapture {
  file: string
  start: number
  end: number
  mode: "not_required" | "required"
  /** The file's own code, made runnable by erasing only the generated TypeScript types. */
  browserCode: string
}

function statementLines(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).join("\n")
}

/** Nothing executable may precede the capture: imports and client/strict directives are allowed. */
function onlyModulePreamble(source: string, end: number, states: Uint8Array): boolean {
  let cursor = 0
  while (cursor < end) {
    while (cursor < end && (/\s/.test(source[cursor]!) || states[cursor] === 3)) cursor += 1
    if (cursor >= end) return true
    const rest = source.slice(cursor, end)
    const directive = /^(?:"use client"|'use client'|"use strict"|'use strict')\s*;?/.exec(rest)
    if (directive) {
      cursor += directive[0].length
      continue
    }
    const imported = /^import\s+(?:(?:type\s+)?[^;]*?\s+from\s+)?["'][^"']+["']\s*;?/.exec(rest)
    if (!imported) return false
    cursor += imported[0].length
  }
  return true
}

function browserCodeFromSite(fragment: string, typescript: boolean): string {
  if (!typescript) return fragment
  return fragment
    .replace(/const window:\s*any\s*=/, "const window =")
    .replace(/const navigator:\s*any\s*=/, "const navigator =")
    .replace(/function infiniteConsentGate\(start:\s*\(\) => void\)/, "function infiniteConsentGate(start)")
    .replace(/function storedFbcs\(usableOnly:\s*boolean\)/, "function storedFbcs(usableOnly)")
    .replace(/function format\(index:\s*number, fbclid:\s*string\)/, "function format(index, fbclid)")
    .replace(/function domainIndex\(domain:\s*string\)/, "function domainIndex(domain)")
}

/** Null is an honest unknown: comment, string, dead function, changed statement, or unsupported placement. */
export function readExecutableModuleCapture(file: string, source: string): ExecutableModuleCapture | null {
  const typescript = /\.[cm]?ts$/i.test(file)
  if (!typescript && !/\.[cm]?js$/i.test(file)) return null
  const states = lexicalStates(source)
  let search = 0
  for (;;) {
    const start = source.indexOf("(function () {", search)
    if (start < 0) return null
    search = start + 1
    if (states[start] !== 0 || source.slice(source.lastIndexOf("\n", start - 1) + 1, start).trim() !== "" || !onlyModulePreamble(source, start, states)) continue
    let endSearch = start
    for (;;) {
      const tail = source.indexOf("})();", endSearch)
      if (tail < 0) break
      endSearch = tail + 5
      if (states[tail] !== 0) continue
      const end = tail + 5
      const fragment = source.slice(source.lastIndexOf("\n", start - 1) + 1, end)
      for (const mode of ["not_required", "required"] as const) {
        const gate = { kind: "infinite-consent" as const, mode }
        const canonical = typescript ? buildMetaClickIdCaptureTypescript({ gate }) : buildMetaClickIdCaptureJavascript({ gate })
        if (statementLines(fragment) !== statementLines(canonical)) continue
        // The brief places it before the adopted init in this same module.
        const pixel = [...source.matchAll(/\bfbq\s*\(\s*["']init["']/g)].find((match) => states[match.index ?? 0] === 0)
        if (!pixel || (pixel.index ?? 0) < end) return null
        return { file, start, end, mode, browserCode: browserCodeFromSite(fragment, typescript) }
      }
    }
  }
}
