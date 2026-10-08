/** Fixed, installer-owned landing capture. The pixel's own file is read only. */
import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync } from "node:fs"
import { join, posix } from "node:path"
import type { ManualRequirement, ManagedCaptureRecord } from "../types.js"
import type { WizardEditRecord } from "../wizard/contracts/jobs.js"
import type { AdoptedMetaFact } from "./improve.js"
import { buildMetaClickIdCaptureJavascript, buildMetaClickIdCaptureScript } from "../providers/meta-browser/click-id.js"
import { lexicalStates } from "../lexical-states.js"
import { readInstallManifest } from "../manifest.js"
import { assertConfinedManifestFileEntry, normalizeAppRelativePath, writeFileAtomic } from "../frameworks/shared.js"
import { ownerWiringRequirement, policyWiringRequirement } from "../frameworks/owner-boundary.js"
import { generatedApiTexts, recordGeneratedApi } from "../jobs/generated-api.js"
import { makeEditRecord } from "./edits.js"

export interface ManagedCapturePlan {
  requirements: ManualRequirement[]
  /** Only the fixed entries that can actually load the capture. Skipped pages stay in requirements. */
  entrypoints: string[]
  /** Entries needing a write; a verified loader the owner already added stays read only. */
  editEntrypoints: string[]
  module: string
  canWire: boolean
  pixelFiles: string[]
  strategy: ManagedCaptureRecord["strategy"]
}
export interface ManagedCaptureInput {
  root: string; appRoot: string; framework: string
  pixels: readonly AdoptedMetaFact[]
  htmlPages?: readonly string[]
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const ASSET = "infinite-meta-click-id.js"
const SCRIPT_IMPORT = 'import InfiniteMetaCaptureScript from "next/script"'
const NEXT_TAG = '<InfiniteMetaCaptureScript id="infinite-meta-click-id" src="/infinite-meta-click-id.js" strategy="beforeInteractive" />'
const HTML_TAG = '<script src="/infinite-meta-click-id.js" data-infinite-meta-capture></script>'

function canonicalCapture(mode: ManagedCaptureRecord["mode"], strategy: ManagedCaptureRecord["strategy"]): string {
  const gate = { kind: "infinite-consent" as const, mode }
  const emitted = strategy === "first_import" ? buildMetaClickIdCaptureJavascript({ gate }) : buildMetaClickIdCaptureScript({ gate })
  // The standalone file is linted as customer source. These are the fixed factory's mutable locals;
  // all other declarations are constants. Consent and cookie behavior remains the same factory code.
  const mutable = new Set(["decision", "started", "newest", "index", "size", "other", "narrower", "lastConsentGestureAt", "captureConsentDecision", "ownedFbcValue"])
  const modern = emitted.replace(/\bvar\s+([A-Za-z_$][\w$]*)/g, (_match, name: string) => `${mutable.has(name) ? "let" : "const"} ${name}`).replace(/catch\s*\(_error\)/g, "catch").replace(/catch\s*\{\s*\}/g, "catch { /* Browser storage or hooks may be unavailable. */ }")
  return "// Managed by Infinite. Public install artifacts only.\n" + modern + "\n"
}
function firstStatement(source: string): number {
  const states = lexicalStates(source)
  let at = 0
  for (;;) {
    while (at < source.length && (/\s/.test(source[at]!) || states[at] === 3)) at++
    const directive = /^(?:"use (?:client|server|strict)"|'use (?:client|server|strict)')\s*;?/.exec(source.slice(at))
    if (!directive) return at
    at += directive[0].length
  }
}
function moduleImport(entry: string, module: string): string {
  const relative = posix.relative(posix.dirname(entry), module)
  return `import ${JSON.stringify(relative.startsWith(".") ? relative : `./${relative}`)}`
}
function htmlSlot(source: string, next: boolean): number | null {
  const states = lexicalStates(source)
  if (next) {
    // A narrow unconditional default root layout. Helpers, arrow roots and alternate returns need
    // owner placement; a head merely present inside an uncalled function proves nothing.
    const functions = [...source.matchAll(/\bfunction\b/g)].filter(match => states[match.index!] === 0)
    const root = /\bexport\s+default\s+(?:async\s+)?function\s*(?:[A-Za-z_$][\w$]*\s*)?\(/.exec(source)
    if (!root || states[root.index] !== 0 || functions.length !== 1 || [...source.matchAll(/=>/g)].some(match => states[match.index!] === 0)) return null
    let at = root.index + root[0].length, depth = 1
    for (; at < source.length && depth; at++) if (states[at] === 0) { if (source[at] === "(") depth++; if (source[at] === ")") depth-- }
    if (depth !== 0) return null
    const body = /^\s*\{\s*(?:(?:const|let)\s+[A-Za-z_$][\w$]*[^;]*;\s*)*return\s*(?:\(\s*)?<html\b[^>]*>\s*<(head|body)\b[^>]*>/i.exec(source.slice(at))
    if (!body) return null
    const slot = at + body[0].length
    const tagAt = source.lastIndexOf(`<${body[1]}`, slot)
    return tagAt >= 0 && states[tagAt] === 0 ? slot : null
  }
  for (const tag of next ? ["head", "body"] : ["head"]) {
    const hits = [...source.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "gi"))].filter(match => states[match.index!] === 0 && source.lastIndexOf("<!--", match.index!) <= source.lastIndexOf("-->", match.index!))
    if (hits.length > 1) return null
    if (hits.length === 1) {
      const headAt = hits[0]!.index!
      // The loader cannot precede an executable script already outside the explicit head.
      const earlierScript = [...source.slice(0, headAt).matchAll(/<script\b/gi)].some(match => source.lastIndexOf("<!--", match.index!) <= source.lastIndexOf("-->", match.index!))
      return earlierScript ? null : headAt + hits[0]![0].length
    }
  }
  return null
}
function wired(source: string, entry: string, module: string, strategy: ManagedCaptureRecord["strategy"]): boolean {
  const expected = strategy === "first_import" ? moduleImport(entry, module) : strategy === "before_interactive" ? NEXT_TAG : HTML_TAG
  if (source.split(expected).length !== 2) return false
  if (strategy === "first_import") return source.slice(firstStatement(source)).startsWith(expected)
  const slot = htmlSlot(source, strategy === "before_interactive")
  if (slot === null || !source.slice(slot).startsWith(`\n  ${expected}`)) return false
  if (strategy === "before_interactive") {
    const states = lexicalStates(source)
    const at = source.indexOf(SCRIPT_IMPORT)
    const names = [...source.matchAll(/\bInfiniteMetaCaptureScript\b/g)].filter(match => states[match.index!] === 0)
    if (at < 0 || states[at] !== 0 || names.length !== 2) return false
  }
  return true
}

function runtimeImports(file: string, source: string): string[][] {
  const states = lexicalStates(source)
  return [...source.matchAll(/\b(?:import|export)\s+(type\s+)?(?:(?:[^;"']|\n)*?\s+from\s+)?["'](\.[^"']+)["']/g)].filter(match => states[match.index!] === 0 && !match[1] && !/^import\s*\{\s*type\b/.test(match[0])).map(match => {
    const base = posix.normalize(posix.join(posix.dirname(file), match[2]!))
    if (base.startsWith("/") || base.split("/").includes("..")) return []
    return [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", "/index.ts", "/index.tsx", "/index.js"].map(extension => base + extension)]
  })
}
function reachablePixels(root: string, entry: string, pixels: readonly string[]): boolean {
  const seen = new Set<string>(), queue = [entry]
  while (queue.length && seen.size < 256) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    let source: string
    try { source = readFileSync(join(root, file), "utf8") } catch { return false }
    for (const candidates of runtimeImports(file, source)) {
      const next = candidates.find(path => existsSync(join(root, path)) && lstatSync(join(root, path)).isFile())
      if (next) queue.push(next)
    }
  }
  return queue.length === 0 && pixels.every(file => seen.has(file))
}
function sideEffectsPreserved(root: string, appRoot: string): boolean {
  try {
    const setting = JSON.parse(readFileSync(join(root, appRoot, "package.json"), "utf8")).sideEffects
    return setting === undefined || setting === true
  } catch { return false }
}
function assetMappingKnown(root: string, appRoot: string, framework: string): boolean {
  const stem = framework === "next-app-router" ? "next" : framework === "vite-react" ? "vite" : null
  if (!stem) return true
  const option = framework === "next-app-router" ? "basePath" : "publicDir"
  for (const extension of ["js", "mjs", "cjs", "ts", "mts", "cts"]) {
    const path = join(root, appRoot, `${stem}.config.${extension}`)
    if (!existsSync(path)) continue
    try {
      const source = readFileSync(path, "utf8"), states = lexicalStates(source)
      if ([...source.matchAll(new RegExp(`\\b${option}\\b`, "g"))].some(match => states[match.index!] !== 3)) return false
    } catch { return false }
  }
  return true
}
function pixelOrderKnown(file: string, source: string, strategy: ManagedCaptureRecord["strategy"]): boolean {
  if (strategy === "blocking_script") return true
  // Next's module ordering does not establish order against native server-rendered scripts.
  if (/\.html?$/i.test(file) || /<script\b/.test(source)) return false
  if (strategy === "first_import" && /(?:^|\/)pages\/_document\./.test(file)) return false
  if (/\bstrategy\s*=\s*["']beforeInteractive["']/.test(source)) return strategy === "before_interactive" && /(?:^|\/)app\/layout\.tsx$/.test(file)
  return true
}
function proposal(source: string, entry: string, module: string, strategy: ManagedCaptureRecord["strategy"]): { after: string; snippet: string } | null {
  const snippet = strategy === "first_import" ? moduleImport(entry, module) : strategy === "before_interactive" ? `${SCRIPT_IMPORT}\n\n${NEXT_TAG}` : HTML_TAG
  if (wired(source, entry, module, strategy)) return { after: source, snippet }
  // An existing but differently placed loader is not moved or duplicated.
  if (source.includes(ASSET) || source.includes("InfiniteMetaCaptureScript")) return null
  let after = source
  if (strategy === "first_import") {
    const at = firstStatement(source)
    after = source.slice(0, at) + snippet + "\n" + source.slice(at)
  } else {
    const slot = htmlSlot(source, strategy === "before_interactive")
    if (slot === null) return null
    after = source.slice(0, slot) + `\n  ${strategy === "before_interactive" ? NEXT_TAG : HTML_TAG}` + source.slice(slot)
    if (strategy === "before_interactive") {
      const at = firstStatement(after)
      after = after.slice(0, at) + SCRIPT_IMPORT + "\n" + after.slice(at)
    }
  }
  return wired(after, entry, module, strategy) ? { after, snippet } : null
}
function unknown(path: string, snippet: string, why: string): ManualRequirement {
  return { path, snippet, reason: `Load it first in ${path}; the wizard could not place it there safely (${why}).`, ownerBoundary: { kind: "unproven_wiring", file: path, line: 1 } }
}

export function planManagedCapture(input: ManagedCaptureInput): ManagedCapturePlan | undefined {
  const pixels = input.pixels.filter(pixel => !pixel.captureNearby)
  if (!pixels.length) return undefined
  const strategy: ManagedCaptureRecord["strategy"] = input.framework === "next-pages-router" ? "first_import" : input.framework === "next-app-router" ? "before_interactive" : "blocking_script"
  const module = normalizeAppRelativePath(input.appRoot, input.framework === "next-pages-router" ? `lib/${ASSET}` : input.framework === "static-html" ? ASSET : `public/${ASSET}`)
  const fixed = input.framework === "next-pages-router" ? ["pages/_app.tsx"] : input.framework === "next-app-router" ? ["app/layout.tsx"] : input.framework === "vite-react" ? ["index.html"] : input.framework === "static-html" ? input.htmlPages ?? ["index.html"] : []
  const targets = fixed.map(file => normalizeAppRelativePath(input.appRoot, file))
  const result: ManagedCapturePlan = { module, strategy, pixelFiles: pixels.map(pixel => normalizeAppRelativePath(input.appRoot, pixel.file)), entrypoints: [], editEntrypoints: [], requirements: [], canWire: false }
  const earlierPixel = pixels.some(pixel => ((pixel.html || pixel.nextScript) && !pixel.executable)) || result.pixelFiles.some(file => {
    try {
      assertConfinedManifestFileEntry(input.root, file)
      return !pixelOrderKnown(file, readFileSync(join(input.root, file), "utf8"), strategy)
    } catch { return true }
  })
  const assetMapping = assetMappingKnown(input.root, input.appRoot, input.framework)
  let moduleOwned = true
  if (existsSync(join(input.root, module))) {
    try {
      const held = readInstallManifest(input.root)?.managedCapture
      const content = readFileSync(join(input.root, module), "utf8")
      moduleOwned = lstatSync(join(input.root, module)).isFile() && held?.module === module && held.strategy === strategy && (held.mode === "required" || held.mode === "not_required") && held.moduleHash === hash(content) && (content === canonicalCapture(held.mode, strategy) || generatedApiTexts(input.root, module).includes(content))
    } catch { moduleOwned = false }
  }
  for (const entry of targets) {
    const snippet = strategy === "first_import" ? moduleImport(entry, module) : strategy === "before_interactive" ? `${SCRIPT_IMPORT}\n\n${NEXT_TAG}` : HTML_TAG
    const policy = policyWiringRequirement(entry, snippet, input.appRoot)
    if (policy) { result.requirements.push(policy); continue }
    if (!assetMapping) { result.requirements.push(unknown(entry, snippet, "custom public-asset paths require owner placement")); continue }
    if (earlierPixel || !moduleOwned) { result.requirements.push(unknown(entry, snippet, earlierPixel ? "pixel execution may precede this fixed entry" : "the target module is not recorded as ours")); continue }
    if (strategy === "first_import") {
      if (!sideEffectsPreserved(input.root, input.appRoot) || !reachablePixels(input.root, entry, result.pixelFiles)) { result.requirements.push(unknown(entry, snippet, "a first import before the pixel could not be proved")); continue }
    }
    let before: string
    try { assertConfinedManifestFileEntry(input.root, entry); before = readFileSync(join(input.root, entry), "utf8") }
    catch { result.requirements.push(unknown(entry, snippet, "the fixed entry could not be read")); continue }
    const edit = proposal(before, entry, module, strategy)
    if (!edit) { result.requirements.push(unknown(entry, snippet, "initial execution order could not be established")); continue }
    const protectedEdit = ownerWiringRequirement(entry, before, edit.after, snippet, input.appRoot)
    if (protectedEdit) result.requirements.push(protectedEdit)
    else { result.entrypoints.push(entry); if (edit.after !== before) result.editEntrypoints.push(entry) }
  }
  result.canWire = result.entrypoints.length > 0
  return result
}

export function applyManagedCapture(input: ManagedCaptureInput & { mode: ManagedCaptureRecord["mode"]; runId: string; seq: number }): { plan?: ManagedCapturePlan; record?: ManagedCaptureRecord; changedFiles: string[]; edits: WizardEditRecord[] } {
  const plan = planManagedCapture(input)
  const result: { plan?: ManagedCapturePlan; record?: ManagedCaptureRecord; changedFiles: string[]; edits: WizardEditRecord[] } = { plan, changedFiles: [], edits: [] }
  if (!plan?.canWire) return result
  const source = canonicalCapture(input.mode, plan.strategy)
  const writes: Array<{ file: string; before: string | null; after: string }> = plan.entrypoints.map(path => {
    const before = readFileSync(join(input.root, path), "utf8")
    const edit = proposal(before, path, plan.module, plan.strategy)
    if (!edit || ownerWiringRequirement(path, before, edit.after, edit.snippet, input.appRoot)) throw new Error(`The capture entry changed before apply: ${path}`)
    return { file: path, before, after: edit.after }
  })
  assertConfinedManifestFileEntry(input.root, plan.module)
  writes.unshift({ file: plan.module, before: existsSync(join(input.root, plan.module)) ? readFileSync(join(input.root, plan.module), "utf8") : null, after: source })
  recordGeneratedApi(input.root, plan.module, source)
  for (const edit of writes) if (edit.before !== edit.after) {
    writeFileAtomic(join(input.root, edit.file), edit.after)
    result.changedFiles.push(edit.file)
    result.edits.push(makeEditRecord({ ...edit, jobId: "meta_improve:capture", planLineId: "capture_beside_adopted_pixel:meta:capture", by: "wizard", runId: input.runId, seq: input.seq++ }))
  }
  result.record = { module: plan.module, entrypoints: [...plan.entrypoints], pixelFiles: [...plan.pixelFiles], mode: input.mode, strategy: plan.strategy, moduleHash: hash(source) }
  return result
}

/** No presence-only pass: require the recorded canonical module and each exact early entry loader. */
function readCaptureUsing(root: string, readText: (path: string) => string | null): { record: ManagedCaptureRecord; browserCode: string } | null {
  try {
    const raw = readText(join(root, ".infinite/install.json"))
    const receipt = raw ? JSON.parse(raw) : null
    const record = receipt?.managedCapture as ManagedCaptureRecord | undefined
    if (!record || !["required", "not_required"].includes(record.mode) || !["first_import", "before_interactive", "blocking_script"].includes(record.strategy) || !Array.isArray(record.entrypoints) || !record.entrypoints.length || !Array.isArray(record.pixelFiles)) return null
    const paths = [record.module, ...record.entrypoints, ...record.pixelFiles]
    if (paths.some(path => typeof path !== "string" || path.startsWith("/") || path.split("/").includes(".."))) return null
    for (const path of paths) assertConfinedManifestFileEntry(root, path)
    const source = readText(join(root, record.module))
    if (source === null || source !== canonicalCapture(record.mode, record.strategy) || hash(source) !== record.moduleHash) return null
    const appRoot = typeof receipt.appRoot === "string" ? receipt.appRoot : "."
    if (appRoot.startsWith("/") || appRoot.split("/").includes("..")) return null
    const framework = receipt.framework
    if (!assetMappingKnown(root, appRoot, framework)) return null
    const expectedModule = normalizeAppRelativePath(appRoot, record.strategy === "first_import" ? `lib/${ASSET}` : framework === "static-html" ? ASSET : `public/${ASSET}`)
    if (record.module !== expectedModule || !record.pixelFiles.length) return null
    if ((record.strategy === "first_import" && framework !== "next-pages-router") || (record.strategy === "before_interactive" && framework !== "next-app-router") || (record.strategy === "blocking_script" && !["static-html", "vite-react"].includes(framework))) return null
    for (const file of record.pixelFiles) {
      const pixel = readText(join(root, file))
      if (pixel === null || !/\bfbq\s*(?:\?\.)?\(\s*["']init["']/.test(pixel) || !pixelOrderKnown(file, pixel, record.strategy)) return null
    }
    for (const entry of record.entrypoints) {
      const text = readText(join(root, entry))
      if (text === null || !wired(text, entry, record.module, record.strategy)) return null
      if (record.strategy === "first_import" && (entry !== normalizeAppRelativePath(appRoot, "pages/_app.tsx") || !sideEffectsPreserved(root, appRoot) || !reachablePixels(root, entry, record.pixelFiles))) return null
      if (record.strategy === "before_interactive" && entry !== normalizeAppRelativePath(appRoot, "app/layout.tsx")) return null
    }
    return { record, browserCode: source }
  } catch { return null }
}

/** Synchronous setup scans use the identical receipt and entry validation. */
export function readManagedCaptureSync(root: string): { record: ManagedCaptureRecord; browserCode: string } | null {
  return readCaptureUsing(root, path => { try { return readFileSync(path, "utf8") } catch { return null } })
}

export async function readManagedCapture(root: string, readText: (path: string) => Promise<string | null>): Promise<{ record: ManagedCaptureRecord; browserCode: string } | null> {
  try {
    const manifest = join(root, ".infinite/install.json")
    const raw = await readText(manifest)
    const record = raw ? JSON.parse(raw)?.managedCapture as ManagedCaptureRecord | undefined : undefined
    if (!record || !Array.isArray(record.entrypoints) || !Array.isArray(record.pixelFiles)) return null
    const paths = [record.module, ...record.entrypoints, ...record.pixelFiles]
    if (paths.some(path => typeof path !== "string" || path.startsWith("/") || path.split("/").includes(".."))) return null
    const files = new Map<string, string | null>([[manifest, raw]])
    for (const path of paths) {
      assertConfinedManifestFileEntry(root, path)
      files.set(join(root, path), await readText(join(root, path)))
    }
    return readCaptureUsing(root, path => files.get(path) ?? null)
  } catch { return null }
}
