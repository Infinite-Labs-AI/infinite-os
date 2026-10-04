// §3y.2 / DECISIONS §1.2: the site-file claim's ONE managed file, `.well-known/infinite-site-verification.txt`,
// written where the framework serves it at the site's root. It holds the cloud's public proof body (never a
// secret: it is served on the site by design) and is recorded in `.infinite/install.json` as the wizard's own
// edit (`by:"wizard"`, `planLineId:"install_provider:infinite"`, `jobId:null`), so the PR carries it and
// `uninstall --pr` removes it.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { SITE_PROOF_BODY_PATTERN, SITE_PROOF_PATH } from "../wizard/contracts/bridge.js"

export const PROOF_FILE_PLAN_LINE_ID = "install_provider:infinite" as const

/** Repo-relative: `<appRoot>/<rest>` (or `<rest>` at the repo root). */
function repoRelative(appRoot: string, rest: string): string {
  return appRoot === "." || appRoot === "" ? rest : `${appRoot}/${rest}`
}

/**
 * Where the proof file goes for this framework (DECISIONS §1.2 table), or why it cannot be written:
 * - Next (both routers) and Vite serve `<appRoot>/public/` at the root (the build copies it out);
 * - a static site serves the directory of the index.html the installer edits (the app root), unless its
 *   `vercel.json` builds into another directory: then the file is not written and the Infinite line says where.
 */
export function proofFileTarget(root: string, appRoot: string, framework: string): { path: string } | { blocked: string } | { unsupported: true } {
  const rest = SITE_PROOF_PATH.replace(/^\//, "")
  if (framework === "next-app-router" || framework === "next-pages-router" || framework === "vite-react") {
    return { path: repoRelative(appRoot, `public/${rest}`) }
  }
  if (framework === "static-html") {
    const output = vercelOutputDirectory(join(root, appRoot === "." ? "" : appRoot))
    if (output !== null && !["", ".", "./"].includes(output.trim())) return { blocked: output }
    return { path: repoRelative(appRoot, rest) }
  }
  return { unsupported: true }
}

/** The `outputDirectory` a `vercel.json` in `dir` sets, or null (none, or unreadable). */
export function vercelOutputDirectory(dir: string): string | null {
  const file = join(dir, "vercel.json")
  if (!existsSync(file)) return null
  try {
    const value = (JSON.parse(readFileSync(file, "utf8")) as { outputDirectory?: unknown }).outputDirectory
    return typeof value === "string" ? value : null
  } catch {
    return null
  }
}

/** The Infinite line's user_action text when the proof file cannot be placed (DECISIONS §1.2). */
export function proofFileBlockedText(outputDirectory: string): string {
  return `your site builds into ${outputDirectory}; put .well-known/infinite-site-verification.txt there, then run again.`
}

/** True for the exact public proof body the cloud issues (`infinite-site-verification: isv_<22>\n`). */
export function isProofBody(body: string): boolean {
  return SITE_PROOF_BODY_PATTERN.test(body)
}
