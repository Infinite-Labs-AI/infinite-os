/** Read-only entrypoint proposals using exactly the adapter's apply-time source transforms. */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { InstallPlan, ManualRequirement } from "../types.js"
import { upsertLayoutSource, upsertAppSource, managedBlockFor, staticManagedBlockFor } from "./entry-wiring.js"
import { hasManagedHtmlBlock, upsertManagedHtmlBlock } from "./managed-html.js"
import { normalizeAppRelativePath } from "./shared.js"
import { ownerWiringRequirement, policyWiringRequirement } from "./owner-boundary.js"

export interface OwnerWiringPreview {
  requirements: ManualRequirement[]
  entrypoints: string[]
  writableEntrypoints: string[]
  canWire: boolean
}

export function previewOwnerWiring(input: { root: string; appRoot: string; framework: string; plan?: Pick<InstallPlan, "files" | "instructions"> }): OwnerWiringPreview {
  const app = input.appRoot === "." || input.appRoot === "" ? input.root : join(input.root, input.appRoot)
  const fixed = input.framework === "next-app-router" ? "app/layout.tsx" : input.framework === "next-pages-router" ? "pages/_app.tsx" : input.framework === "vite-react" ? "index.html" : null
  const paths = fixed ? [normalizeAppRelativePath(input.appRoot, fixed)] : (input.plan?.files ?? []).filter(path => /\.html?$/i.test(path))
  const result: OwnerWiringPreview = { requirements: [], entrypoints: paths, writableEntrypoints: [], canWire: false }
  for (const path of paths) {
    const relative = input.appRoot === "." || input.appRoot === "" ? path : path.slice(input.appRoot.length + 1)
    const snippet = input.framework.startsWith("next-") ? 'import { InfiniteAnalyticsClient } from "../lib/infinite-analytics-client"\n\n<InfiniteAnalyticsClient />'
      : input.framework === "vite-react" ? managedBlockFor(input.plan?.instructions ?? []) : staticManagedBlockFor(input.plan?.instructions ?? [])
    const policy = policyWiringRequirement(path, snippet, input.appRoot)
    if (policy) { result.requirements.push(policy); continue }
    if (!existsSync(join(app, relative))) { result.requirements.push({ path, snippet, reason: `The fixed entrypoint ${path} is missing.` }); continue }
    const before = readFileSync(join(app, relative), "utf8")
    if (!input.framework.startsWith("next-") && !before.includes("</head>") && !(input.framework === "vite-react" && hasManagedHtmlBlock(before))) {
      result.requirements.push({ path, snippet, reason: `${path} has no </head> to inject into.` }); continue
    }
    let after: string
    try {
      after = input.framework === "next-app-router" ? upsertLayoutSource(before) : input.framework === "next-pages-router" ? upsertAppSource(before) : upsertManagedHtmlBlock(before, snippet)
    } catch {
      result.requirements.push({ path, snippet, reason: `The fixed entrypoint ${path} cannot take the planned wiring.` }); continue
    }
    if (!input.framework.startsWith("next-") && !after.includes(snippet)) {
      result.requirements.push({ path, snippet, reason: `${path} has an incomplete managed block; add the wiring yourself.` }); continue
    }
    const requirement = ownerWiringRequirement(path, before, after, snippet, input.appRoot, input.framework.startsWith("next-") ? [] : [snippet])
    if (requirement) result.requirements.push(requirement)
    else result.writableEntrypoints.push(path)
  }
  result.canWire = result.writableEntrypoints.length > 0
  return result
}
