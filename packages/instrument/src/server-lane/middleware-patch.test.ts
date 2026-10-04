import { describe, expect, it } from "vitest"

import {
  UNPATCHABLE_REASONS,
  importInsertionOffset,
  inspectConfigMatcher,
  isBroadMatcherEntry,
  patchExistingMiddleware
} from "./middleware-patch.js"
import { SERVER_LANE_FENCE_END, SERVER_LANE_FENCE_START } from "./runtime-source.js"
import { applyTextEdits, reverseTextEdits } from "./text-edits.js"

const IMPORT = "./lib/infinite-server-lane"
// Fixture import lines live in constants so package-shape.test.ts's scanner ignores them.
const NEXT_RESPONSE_IMPORT = 'import { NextResponse } from "next/server"'
const NEXT_REQUEST_TYPE_IMPORT = 'import type { NextRequest } from "next/server"'
const NEXT_EVENT_TYPES_IMPORT = 'import type { NextFetchEvent, NextRequest } from "next/server"'
const CLERK_IMPORT = 'import { clerkMiddleware } from "@clerk/nextjs/server"'
const NEXT_INTL_IMPORT = 'import createMiddleware from "next-intl/middleware"'
const NEXT_AUTH_IMPORT = 'import { withAuth } from "next-auth/middleware"'

function patch(source: string) {
  return patchExistingMiddleware(source, { moduleImportPath: IMPORT })
}

function expectPatched(source: string) {
  const result = patch(source)
  if (result.kind !== "patched") {
    throw new Error(`expected patched, got ${JSON.stringify(result)}`)
  }
  // The recorded edits regenerate the patched file from the original and reverse byte-exactly.
  expect(applyTextEdits(source, result.edits)).toBe(result.contents)
  expect(reverseTextEdits(result.contents, result.edits)).toBe(source)
  // Fenced, wrapped, and idempotent.
  expect(result.contents).toContain(SERVER_LANE_FENCE_START)
  expect(result.contents).toContain(SERVER_LANE_FENCE_END)
  expect(result.contents).toContain(`import { withInfiniteServerLane } from "${IMPORT}"`)
  expect(result.contents).toContain(`export default withInfiniteServerLane(${result.innerIdentifier})`)
  expect(patch(result.contents)).toEqual({ kind: "already-patched" })
  return result
}

const NAMED_MIDDLEWARE = `${NEXT_RESPONSE_IMPORT}
${NEXT_REQUEST_TYPE_IMPORT}

export function middleware(request: NextRequest) {
  const response = NextResponse.next()
  response.headers.set("x-hello", "world")
  return response
}
`

describe("patchExistingMiddleware — recognised shapes", () => {
  it("wraps `export function middleware(` (un-exports it, appends the fenced default export)", () => {
    const result = expectPatched(NAMED_MIDDLEWARE)
    expect(result.innerIdentifier).toBe("middleware")
    expect(result.contents).toContain("\nfunction middleware(request: NextRequest) {")
    expect(result.contents).not.toContain("export function middleware")
    // The import fence lands before the first code line (imports hoist anyway).
    expect(result.contents.startsWith(SERVER_LANE_FENCE_START)).toBe(true)
    // The user's body is byte-identical.
    expect(result.contents).toContain('response.headers.set("x-hello", "world")')
  })

  it("wraps `export async function middleware(request, event)`", () => {
    const result = expectPatched(`${NEXT_EVENT_TYPES_IMPORT}
export async function middleware(request: NextRequest, event: NextFetchEvent) {
  return undefined
}
`)
    expect(result.contents).toContain("\nasync function middleware(request: NextRequest, event: NextFetchEvent) {")
  })

  it("wraps `export default function middleware(` by name", () => {
    const result = expectPatched(`export default function middleware(request) {
  return undefined
}
`)
    expect(result.innerIdentifier).toBe("middleware")
    expect(result.contents).toContain("\nfunction middleware(request) {")
  })

  it("wraps `export default async function customName(`", () => {
    const result = expectPatched(`export default async function guard(request) {
  return undefined
}
`)
    expect(result.innerIdentifier).toBe("guard")
    expect(result.contents).toContain("export default withInfiniteServerLane(guard)")
  })

  it("wraps an anonymous `export default async function (` as a function expression", () => {
    const result = expectPatched(`export default async function (request) {
  return undefined
}
`)
    expect(result.innerIdentifier).toBe("infiniteInnerMiddleware")
    expect(result.contents).toContain("const infiniteInnerMiddleware = async function (request) {")
  })

  it("wraps `export const middleware = createMiddleware(routing)` (next-intl style, no matcher)", () => {
    const result = expectPatched(`${NEXT_INTL_IMPORT}
import { routing } from "./i18n/routing"

export const middleware = createMiddleware(routing)
`)
    expect(result.contents).toContain("\nconst middleware = createMiddleware(routing)")
    expect(result.contents).toContain("export default withInfiniteServerLane(middleware)")
  })

  it("wraps `export default clerkMiddleware()` with Clerk's broad matcher", () => {
    const result = expectPatched(`${CLERK_IMPORT}

export default clerkMiddleware()

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
}
`)
    expect(result.contents).toContain("const infiniteInnerMiddleware = clerkMiddleware()")
    expect(result.contents).toContain("export default withInfiniteServerLane(infiniteInnerMiddleware)")
    // Clerk's config export is untouched.
    expect(result.contents).toContain("'/(api|trpc)(.*)',")
  })

  it("wraps `export default withAuth(function middleware…)` (next-auth style)", () => {
    const result = expectPatched(`${NEXT_AUTH_IMPORT}

export default withAuth(
  function middleware(req) {
    return undefined
  },
  { callbacks: { authorized: ({ token }) => !!token } }
)

export const config = { matcher: "/((?!api|_next/static|_next/image|favicon.ico).*)" }
`)
    expect(result.contents).toContain("const infiniteInnerMiddleware = withAuth(")
  })

  it("wraps a bare `export default middleware` identifier", () => {
    const result = expectPatched(`function middleware(request) {
  return undefined
}
export default middleware
`)
    expect(result.contents).toContain("const infiniteInnerMiddleware = middleware\n")
  })

  it("keeps a leading pragma/banner comment first and puts the import fence after it", () => {
    const source = `// @ts-nocheck
/**
 * License banner
 */

${NEXT_RESPONSE_IMPORT}
export function middleware() {
  return NextResponse.next()
}
`
    const result = expectPatched(source)
    const fenceIndex = result.contents.indexOf(SERVER_LANE_FENCE_START)
    expect(result.contents.indexOf("// @ts-nocheck")).toBeLessThan(fenceIndex)
    expect(result.contents.indexOf("License banner")).toBeLessThan(fenceIndex)
    expect(fenceIndex).toBeLessThan(result.contents.indexOf(NEXT_RESPONSE_IMPORT))
  })

  it("adds a trailing newline before the export fence when the file has none", () => {
    const result = expectPatched(`export function middleware() {}`)
    expect(result.contents).toContain("export function".replace("export ", "") + " middleware() {}\n")
  })

  it("also recognises Next.js 16 `export default function proxy(`", () => {
    const result = expectPatched(`export default function proxy(request) {
  return undefined
}
`)
    expect(result.innerIdentifier).toBe("proxy")
  })
})

describe("patchExistingMiddleware — refusals", () => {
  it("refuses a file with no middleware export", () => {
    expect(patch(`export const config = { matcher: "/((?!api).*)" }\nconst helper = 1\n`)).toEqual({
      kind: "unpatchable",
      reason: UNPATCHABLE_REASONS.noExport
    })
  })

  it("refuses two middleware exports", () => {
    expect(
      patch(`export function middleware(req) {}\nexport default function other(req) {}\n`)
    ).toEqual({ kind: "unpatchable", reason: UNPATCHABLE_REASONS.multipleExports })
  })

  it("refuses re-exports", () => {
    expect(patch(`export { default } from "next-auth/middleware"\n`)).toEqual({
      kind: "unpatchable",
      reason: UNPATCHABLE_REASONS.reExport
    })
    expect(patch(`function middleware() {}\nexport { middleware }\n`)).toEqual({
      kind: "unpatchable",
      reason: UNPATCHABLE_REASONS.reExport
    })
  })

  it("refuses an unrecognised default export shape", () => {
    expect(patch(`export default class Guard {}\n`)).toEqual({
      kind: "unpatchable",
      reason: UNPATCHABLE_REASONS.unrecognizedDefault
    })
  })

  it("refuses a NARROW matcher (the lane would only see those pages)", () => {
    expect(
      patch(`export function middleware(req) {}\nexport const config = { matcher: ["/dashboard/:path*"] }\n`)
    ).toEqual({ kind: "unpatchable", reason: UNPATCHABLE_REASONS.matcherNarrow })
    expect(
      patch(`export function middleware(req) {}\nexport const config = { matcher: "/admin/:path*" }\n`)
    ).toEqual({ kind: "unpatchable", reason: UNPATCHABLE_REASONS.matcherNarrow })
  })

  it("refuses a matcher it cannot read", () => {
    expect(
      patch(`export function middleware(req) {}\nconst routes = ["/x"]\nexport const config = { matcher: routes }\n`)
    ).toEqual({ kind: "unpatchable", reason: UNPATCHABLE_REASONS.matcherUnreadable })
    expect(
      patch(`export function middleware(req) {}\nexport const config = { matcher: [{ source: "/x" }] }\n`)
    ).toEqual({ kind: "unpatchable", reason: UNPATCHABLE_REASONS.matcherUnreadable })
  })

  it("refuses a half-installed file that references the module without the fence", () => {
    expect(
      patch(`import { withInfiniteServerLane } from "./lib/infinite-server-lane"\nexport function middleware(req) {}\n`)
    ).toEqual({ kind: "unpatchable", reason: UNPATCHABLE_REASONS.partialInstall })
  })

  it("does not match commented-out exports", () => {
    expect(patch(`// export function middleware(req) {}\nconst x = 1\n`)).toEqual({
      kind: "unpatchable",
      reason: UNPATCHABLE_REASONS.noExport
    })
  })
})

describe("inspectConfigMatcher / isBroadMatcherEntry", () => {
  it.each([
    ["/((?!_next/static|_next/image|favicon.ico|api|.*\\..*).*)", true],
    ["/((?!api|_next/static|_next/image|favicon.ico).*)", true],
    ["/(.*)", true],
    ["/:path*", true],
    ["/dashboard/:path*", false],
    ["/", false],
    ["/(de|en)/:path*", false]
  ])("%s broad=%s", (entry, expected) => {
    expect(isBroadMatcherEntry(entry)).toBe(expected)
  })

  it("no config export → ok; config without matcher → ok", () => {
    expect(inspectConfigMatcher("export function middleware() {}")).toBe("ok")
    expect(inspectConfigMatcher("export function middleware() {}\nexport const config = { runtime: 'nodejs' }")).toBe("ok")
  })

  it("array with a broad entry among narrow ones → ok", () => {
    expect(
      inspectConfigMatcher(`export const config = { matcher: ['/', '/((?!api|_next).*)', ] }`)
    ).toBe("ok")
  })

  it("template literal with substitutions → unreadable", () => {
    expect(inspectConfigMatcher("export const config = { matcher: [`/${prefix}/:path*`] }")).toBe("unreadable")
  })
})

describe("importInsertionOffset", () => {
  it("is 0 for a file starting with code", () => {
    expect(importInsertionOffset('import x from "y"\n')).toBe(0)
  })
  it("skips leading blank and comment lines", () => {
    const source = "\n// one\n/* two */\n/**\n * three\n */\nconst a = 1\n"
    expect(source.slice(importInsertionOffset(source))).toBe("const a = 1\n")
  })
  it("returns the length of a comment-only file", () => {
    expect(importInsertionOffset("// only\n")).toBe("// only\n".length)
  })
})

describe("text edits", () => {
  it("apply + reverse are inverse for multiple edits", () => {
    const original = "abcdefghij"
    const edits = [
      { offset: 0, removed: "", inserted: "<<" },
      { offset: 3, removed: "de", inserted: "XYZ" },
      { offset: 10, removed: "", inserted: ">>" }
    ]
    const installed = applyTextEdits(original, edits)
    expect(installed).toBe("<<abcXYZfghij>>")
    expect(reverseTextEdits(installed, edits)).toBe(original)
  })
  it("refuses to apply when the original text does not match", () => {
    expect(() => applyTextEdits("abc", [{ offset: 0, removed: "x", inserted: "" }])).toThrow(/does not match/)
  })
  it("refuses to reverse when an inserted segment was altered", () => {
    expect(() => reverseTextEdits("zzabc", [{ offset: 0, removed: "", inserted: "<<" }])).toThrow(/no longer matches/)
  })
})
