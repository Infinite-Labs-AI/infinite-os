// Freeze the host-realm classes a T0 page is handed (lane O6, review O6-R6). Runs in the T0 CHILD only,
// before any page code. `--frozen-intrinsics` freezes the JavaScript builtins (Array, Map, Promise, …)
// but not Node's web globals, and the page receives the HOST `URL`, `URLSearchParams`, `TextEncoder`,
// `TextDecoder` and `AbortController` (its own vm realm has none). The recorder resolves every request
// URL with that same `URL`, so a page that could redefine `URL.prototype.href` could make a beacon it
// really sent read as a request to somewhere else. Frozen, those redefinitions throw.
//
// Known and accepted: Node keeps `Error.prepareStackTrace` assignable under `--frozen-intrinsics` (for
// source-map tooling). It gives page code no capability: the host's frames are strict-mode ESM, so a
// CallSite exposes neither their `this` nor their function, and code generation from strings is off.
export const HOST_CLASSES_GIVEN_TO_PAGES = [URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal] as const

export function hardenHostRealm(): void {
  for (const value of HOST_CLASSES_GIVEN_TO_PAGES) {
    Object.freeze(value.prototype)
    Object.freeze(value)
  }
}
