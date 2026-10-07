/** Read only a scalar option expression; complex/multiline values remain unknown. */
function readPosthogOption(source: string, key: string): string | undefined {
  return new RegExp(`(?:^|[\\s,{(])${key}\\s*:\\s*([^,\\n}]+)`, "m").exec(source)?.[1]?.trim()
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
  const autocaptureOff = alreadyOff(source ? readPosthogOption(source, "autocapture") : undefined, false, paths)
  const replayOff = alreadyOff(source ? readPosthogOption(source, "disable_session_recording") : undefined, true, paths)
  if (autocaptureOff && replayOff) return null
  const matches = `${JSON.stringify(paths)}.some(function (path) { return location.pathname === path || location.pathname.indexOf(path + "/") === 0; })`
  const off = [!autocaptureOff ? "autocapture: false" : null, !replayOff ? "disable_session_recording: true" : null].filter(Boolean).join(", ")
  return `...((${matches}) ? { ${off} } : {}),`
}
