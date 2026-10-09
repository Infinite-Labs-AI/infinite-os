import { maskCommentsAndStrings } from "../frameworks/shared.js"

/** A single init with a simple literal options object; every other shape stays unknown. */
function selectedOptions(source: string | undefined): Map<string, string> {
  const unknown = new Map<string, string>()
  if (!source) return unknown
  const masked = maskCommentsAndStrings(source, true)
  const commentsOnly = maskCommentsAndStrings(source, false)
  const inits = [...masked.matchAll(/\bposthog\s*\.\s*init\s*\(/g)]
  if (inits.length !== 1) return unknown
  const at = inits[0]!.index! + inits[0]![0].length
  // Only a simple first argument and an actual object second argument. No variable resolution.
  const args = /^[^,(){}]*,\s*\{/.exec(masked.slice(at))
  if (!args) return unknown
  const open = at + args[0].length - 1
  const close = masked.indexOf("}", open + 1)
  if (close < 0 || !/^\s*[,)]/.test(masked.slice(close + 1))) return unknown
  const body = masked.slice(open + 1, close)
  // Nested objects, computed properties and spreads could override the plain values.
  if (/[{}\[\]]|\.\.\./.test(body)) return unknown
  const options = new Map<string, string>()
  let start = open + 1
  for (const segment of body.split(",")) {
    const raw = commentsOnly.slice(start, start + segment.length)
    start += segment.length + 1
    if (!raw.trim()) continue
    const property = /^\s*(?:([A-Za-z_$][\w$]*)|["']([A-Za-z_$][\w$]*)["'])\s*:\s*([\s\S]*?)\s*$/.exec(raw)
    if (!property) return unknown
    // Map.set keeps the LAST duplicate, matching object-literal evaluation.
    options.set(property[1] ?? property[2]!, property[3]!)
  }
  return options
}

/** Only recognise plain existing exclusions; never execute the site's configuration. */
function alreadyOff(value: string | undefined, disabled: boolean, paths: readonly string[]): boolean {
  if (value === String(disabled)) return true
  if (!value || paths.length === 0) return false
  return paths.every(path => {
    const quoted = `(?:"${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"|'${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}')`
    const predicate = `(?:window\\.)?location\\.pathname(?:\\s*===\\s*${quoted}|\\.startsWith\\(\\s*${quoted}\\s*\\))`
    return new RegExp(`^\\s*${predicate}\\s*\\?\\s*${disabled}\\s*:`).test(value)
      || new RegExp(`^\\s*${disabled ? "" : "!\\s*"}${predicate}\\s*$`).test(value)
  })
}

/** Append LAST to the existing options: overrides only towards less collection on named pages. */
export function sensitivePosthogOptions(source: string | undefined, paths: readonly string[]): string | null {
  if (paths.length === 0) return null
  const options = selectedOptions(source)
  const autocaptureOff = alreadyOff(options.get("autocapture"), false, paths)
  const replayOff = alreadyOff(options.get("disable_session_recording"), true, paths)
  if (autocaptureOff && replayOff) return null
  const matches = `${JSON.stringify(paths)}.some(function (path) { return location.pathname === path || location.pathname.indexOf(path + "/") === 0; })`
  const off = [!autocaptureOff ? "autocapture: false" : null, !replayOff ? "disable_session_recording: true" : null].filter(Boolean).join(", ")
  return `...((${matches}) ? { ${off} } : {}),`
}
