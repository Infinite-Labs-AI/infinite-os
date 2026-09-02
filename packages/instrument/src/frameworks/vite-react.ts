// Vite + React adapter.
//
// The analytics tag is injected as a managed `<script>` block into index.html — exactly like the
// static-html adapter — with the provider config BAKED in at install time. The React entrypoint
// (`src/main.*`) is NEVER read, parsed, or edited on ANY code path: the injected runtime installs its
// own SPA history hooks (pushState/replaceState + popstate), so page + click capture works without
// touching bootstrap. This is deliberate — entrypoint bootstrap-detection was an un-winnable scanner
// tarpit (comments, templates, type-only imports, aliases, lexical shadows), and index.html injection
// has no entrypoint surface to get wrong.
import { join } from "node:path"

import type { FrameworkAdapter, InstallInstruction, ManualRequirement } from "../types.js"
import { infiniteProxySpec } from "../workspace-artifacts.js"

import {
  buildManagedHtmlBlock,
  hasManagedHtmlBlock,
  stripManagedHtmlBlock,
  upsertManagedHtmlBlock
} from "./managed-html.js"
import {
  fileExists,
  hasDependency,
  normalizeAppRelativePath,
  readRequiredFile,
  writeFileIfChanged
} from "./shared.js"
import {
  applyManagedVercelJson,
  buildVercelJson,
  reverseManagedVercelJson,
  VERCEL_CONFIG_FILE,
  VERCEL_HOST_CAVEAT
} from "./vercel-config.js"

const INDEX_HTML = "index.html"

/** index.html can take the managed block when it has a </head>, or already carries our block. */
function indexHtmlCanInject(html: string): boolean {
  return html.includes("</head>") || hasManagedHtmlBlock(html)
}

/** The provider `<script>…</script>` snippets targeting index.html, assembled into the managed block. */
function managedBlockFor(instructions: InstallInstruction[]): string {
  const providerSnippets = instructions
    .filter((instruction) => instruction.provider && instruction.path.endsWith(INDEX_HTML))
    .map((instruction) => instruction.snippet.trim())
    .filter((snippet) => snippet.length > 0)
  return buildManagedHtmlBlock(providerSnippets)
}

export const viteReactAdapter: FrameworkAdapter = {
  id: "vite-react",
  displayName: "Vite React",
  detect(root) {
    // Metadata + file existence ONLY. The React entrypoint source never influences detection.
    if (!hasDependency(root, "vite") || !hasDependency(root, "react")) {
      return null
    }
    if (!fileExists(root, INDEX_HTML)) {
      return null
    }
    return {
      framework: "vite-react",
      confidence: 0.92,
      files: [INDEX_HTML],
      assumptions: [
        "Vite React wiring injects the managed analytics <script> into index.html; the React entrypoint (src/main.*) is never read or edited."
      ]
    }
  },
  plan(root, options) {
    const detected = this.detect(root)
    const proxy = {
      posthog: options?.posthogProxy,
      infinite: options?.infiniteProxy
    }
    const hasManagedProxy = Boolean(proxy.posthog || proxy.infinite)

    const blockers: string[] = []
    const assumptions = [
      "Vite React public IDs are baked into the injected index.html <script> at install time."
    ]
    if (!fileExists(root, INDEX_HTML)) {
      blockers.push("Vite React apply requires an index.html file.")
    }
    if (
      proxy.infinite &&
      !options?.allowStaticVercelProxy &&
      !fileExists(root, VERCEL_CONFIG_FILE)
    ) {
      blockers.push(
        "Infinite requires a proven same-origin proxy. Add vercel.json or pass --infinite-static-proxy vercel."
      )
    }

    // index.html is a MANAGED file only when it can actually take the block. When it exists but has no
    // </head>, apply() falls CLOSED to the manual path: exit 2 + the exact <script> to paste. This is
    // the only path on which the exit-2 / requires_manual machinery is now reachable.
    const injectable =
      fileExists(root, INDEX_HTML) && indexHtmlCanInject(readRequiredFile(root, INDEX_HTML))
    if (fileExists(root, INDEX_HTML) && !injectable) {
      assumptions.push(
        "index.html has no </head> to inject into; the managed <script> is surfaced as a manual step."
      )
    }

    const files: string[] = injectable ? [INDEX_HTML] : []
    const instructions: InstallInstruction[] = []
    if (hasManagedProxy) {
      const vercelExists = fileExists(root, VERCEL_CONFIG_FILE)
      files.push(VERCEL_CONFIG_FILE)
      instructions.push({
        path: VERCEL_CONFIG_FILE,
        action: vercelExists ? "modify" : "create",
        description: vercelExists
          ? "Merge the managed analytics rewrites into your existing vercel.json."
          : "Create vercel.json with the managed analytics rewrites.",
        snippet: buildVercelJson(proxy)
      })
    }

    return {
      files,
      applyMode: blockers.length === 0 ? "supported" : "plan-only",
      instructions,
      assumptions,
      blockers,
      confidence: detected?.confidence ?? 0.88
    }
  },
  apply(context) {
    const appRoot = context.appRoot === "." ? context.root : join(context.root, context.appRoot)
    const changedFiles: string[] = []
    const warnings: string[] = []
    const requiresManual: ManualRequirement[] = []
    const configOwnership = {}

    const managedBlock = managedBlockFor(context.plan.instructions)
    const indexRootRelative = normalizeAppRelativePath(context.appRoot, INDEX_HTML)

    if (!fileExists(appRoot, INDEX_HTML)) {
      requiresManual.push({
        path: indexRootRelative,
        reason: "index.html was not found",
        snippet: managedBlock
      })
    } else {
      const html = readRequiredFile(appRoot, INDEX_HTML)
      if (indexHtmlCanInject(html)) {
        const nextHtml = upsertManagedHtmlBlock(html, managedBlock)
        if (writeFileIfChanged(appRoot, INDEX_HTML, nextHtml)) {
          changedFiles.push(indexRootRelative)
        }
      } else {
        // Genuine edge: no </head> to inject into. Fail closed with the exact block to add by hand.
        requiresManual.push({
          path: indexRootRelative,
          reason: "index.html has no </head> to inject into",
          snippet: managedBlock
        })
      }
    }

    // vercel.json proxy is written exactly ONCE, same as static-html.
    const proxy = {
      posthog: context.plan.artifacts.posthog?.proxy,
      infinite: infiniteProxySpec(context.plan.artifacts.infinite)
    }
    if (proxy.posthog || proxy.infinite) {
      const rootRelativeConfig = normalizeAppRelativePath(context.appRoot, VERCEL_CONFIG_FILE)
      const appliedConfig = applyManagedVercelJson({
        appRootAbsolute: appRoot,
        proxy,
        previousOwnership: context.previousManifest?.configOwnership?.[rootRelativeConfig]
      })
      if (appliedConfig.changed) {
        changedFiles.push(rootRelativeConfig)
      }
      if (appliedConfig.ownership) {
        Object.assign(configOwnership, { [rootRelativeConfig]: appliedConfig.ownership })
      }
      warnings.push(VERCEL_HOST_CAVEAT)
    }

    return {
      changedFiles,
      warnings,
      configOwnership,
      ...(requiresManual.length > 0 ? { requiresManual } : {})
    }
  },
  uninstall(context) {
    const appRoot = context.appRoot === "." ? context.root : join(context.root, context.appRoot)
    const restoredFiles: string[] = []
    const warnings: string[] = []

    const indexRootRelative = normalizeAppRelativePath(context.appRoot, INDEX_HTML)
    if (context.manifest.files.includes(indexRootRelative)) {
      if (!fileExists(appRoot, INDEX_HTML)) {
        warnings.push(`Managed file already absent: ${indexRootRelative}`)
      } else {
        const html = readRequiredFile(appRoot, INDEX_HTML)
        const nextHtml = stripManagedHtmlBlock(html)
        if (nextHtml === html) {
          warnings.push(`No managed Infinite block found in ${indexRootRelative}.`)
        } else {
          if (!context.dryRun) {
            writeFileIfChanged(appRoot, INDEX_HTML, nextHtml)
          }
          restoredFiles.push(indexRootRelative)
        }
      }
    }

    const vercelReversal = reverseManagedVercelJson({
      manifestFiles: context.manifest.files,
      ownership:
        context.manifest.configOwnership?.[
          normalizeAppRelativePath(context.appRoot, VERCEL_CONFIG_FILE)
        ],
      appRootAbsolute: appRoot,
      appRootRelative: context.appRoot,
      dryRun: context.dryRun
    })

    return {
      removedFiles: vercelReversal.removedFiles,
      restoredFiles: [...restoredFiles, ...vercelReversal.restoredFiles],
      warnings: [...warnings, ...vercelReversal.warnings]
    }
  }
}
