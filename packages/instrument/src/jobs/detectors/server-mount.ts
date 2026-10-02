// Job 1 (`server_lane_mount`) trigger detector (lane O8): where the server lane has to be MOUNTED by
// hand (`ios:…/server-lane/copy.ts` `targetMount` / `unpatchable`) or wired into an EXISTING middleware.
//
// - A Node server entry (Express, Fastify, Koa, Hono's `serve`, `http.createServer`) has no safe,
//   reversible place to patch: the lane must be mounted BEFORE the routes and the static handler.
// - An existing Next.js / Vercel middleware (or Next 16 `proxy.ts`) is a finding ONLY when the
//   installer's own patcher refuses it (`patchExistingMiddleware` → `unpatchable`: a narrow or
//   unreadable matcher, a re-export, an unrecognised export shape, a partial install). A middleware the
//   installer patches itself (code job) and one that already carries the `infinite-tag:server-lane`
//   fence are NOT findings: the agent is never sent into a file the installer wires (R2 review P1-4).
import { patchExistingMiddleware } from "../../server-lane/middleware-patch.js"
import type { RepoSnapshot } from "../repo-files.js"
import { codeMatches, isCodeFile, isNonProductPath, sortFindings, type Finding } from "./shared.js"

export const SERVER_LANE_FENCE_START = "infinite-tag:server-lane:start" as const

export type ServerMountKind = "node_server_entry" | "existing_middleware"
export type ServerRuntime = "express" | "fastify" | "koa" | "hono" | "node_http" | "next_middleware" | "next_proxy"

export interface ServerMountFinding extends Finding {
  kind: ServerMountKind
  runtime: ServerRuntime
  /** `existing_middleware` only: why the installer's patcher refused the file. */
  unpatchableReason?: string
}

const SERVER_ENTRY_PATTERNS: Array<{ runtime: ServerRuntime; pattern: RegExp; requires?: RegExp }> = [
  { runtime: "express", pattern: /\bexpress\s*\(\s*\)/g, requires: /\.listen\s*\(|export\s+default\s+app\b|module\.exports\s*=\s*app\b/ },
  { runtime: "fastify", pattern: /\b[Ff]astify\s*\(\s*(?:\{|\))/g, requires: /\.listen\s*\(/ },
  { runtime: "koa", pattern: /\bnew\s+Koa\s*\(/g, requires: /\.listen\s*\(/ },
  { runtime: "hono", pattern: /\bnew\s+Hono\s*\(/g, requires: /\bserve\s*\(|export\s+default\s+app\b/ },
  { runtime: "node_http", pattern: /\b(?:http|https)\s*\.\s*createServer\s*\(|\bcreateServer\s*\(\s*(?:async\s*)?\(?\s*req\b/g, requires: /\.listen\s*\(/ }
]

function middlewareRuntime(path: string, appRoot: string): ServerRuntime | null {
  const relative = appRoot === "." ? path : path.startsWith(`${appRoot}/`) ? path.slice(appRoot.length + 1) : null
  if (relative === null) return null
  if (/^(?:src\/)?middleware\.[cm]?[jt]s$/.test(relative)) return "next_middleware"
  if (/^(?:src\/)?proxy\.[cm]?[jt]s$/.test(relative)) return "next_proxy"
  return null
}

/** Pure: the app's request middleware / Next 16 proxy files (job 13 moves counted paths into it). */
export function detectMiddlewareFiles(snapshot: RepoSnapshot): string[] {
  const out: string[] = []
  for (const [path, text] of snapshot.files) {
    if (isNonProductPath(path) || !isCodeFile(path)) continue
    const runtime = middlewareRuntime(path, snapshot.appRoot)
    if (runtime === "next_middleware" || (runtime === "next_proxy" && PROXY_HANDLER.test(text))) out.push(path)
  }
  return out.sort()
}

const PROXY_HANDLER = /export\s+(?:async\s+)?function\s+proxy\b|export\s+const\s+config\b|from\s+["']next\/server["']/

/** Pure: the mount points the server lane would need by hand. */
export function detectServerMount(snapshot: RepoSnapshot): ServerMountFinding[] {
  const findings: ServerMountFinding[] = []
  for (const [path, text] of snapshot.files) {
    if (isNonProductPath(path) || !isCodeFile(path)) continue
    const runtime = middlewareRuntime(path, snapshot.appRoot)
    if (runtime) {
      // Next 16's `proxy.ts` is only the request proxy when it exports one (a plain `proxy.ts` helper is not).
      const isRequestHandler = runtime === "next_middleware" || PROXY_HANDLER.test(text)
      if (isRequestHandler && !text.includes(SERVER_LANE_FENCE_START)) {
        // The installer patches this file itself unless its patcher refuses: only a refusal is a job.
        const verdict = patchExistingMiddleware(text, { moduleImportPath: "./lib/infinite-server-lane" })
        if (verdict.kind !== "unpatchable") continue
        const exported = codeMatches(text, /export\s+(?:default\s+)?(?:async\s+)?function\b|export\s+default\b|export\s+const\s+(?:middleware|proxy)\b/g)[0]
        findings.push({
          file: path,
          line: exported?.line ?? 1,
          detail: `${runtime === "next_proxy" ? "proxy" : "middleware"} the installer cannot wire by itself`,
          kind: "existing_middleware",
          runtime,
          unpatchableReason: verdict.reason
        })
      }
      continue
    }
    for (const { runtime: entryRuntime, pattern, requires } of SERVER_ENTRY_PATTERNS) {
      const match = codeMatches(text, new RegExp(pattern.source, "g"))[0]
      if (!match) continue
      if (requires && !requires.test(text)) continue
      if (text.includes(SERVER_LANE_FENCE_START)) continue
      findings.push({ file: path, line: match.line, detail: `${entryRuntime} server entry`, kind: "node_server_entry", runtime: entryRuntime })
      break
    }
  }
  return sortFindings(findings)
}
