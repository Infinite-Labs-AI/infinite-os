import { readFileSync } from "node:fs"
import { join } from "node:path"

import { resolveArtifactHostGuard, wrapGuardedSnippet, type HostGuardSpec } from "../host-guard.js"
import type { InstallInstruction, ProviderAdapter, SupportedFramework } from "../types.js"
import { isHtmlInjectedFramework } from "../types.js"
import {
  jsLiteral,
  normalizePosthogApiHost,
  normalizePosthogUiHost,
  validatePosthogProjectKey
} from "./validate.js"

function frameworkEnvKeys(framework: SupportedFramework): string[] {
  switch (framework) {
    case "next-app-router":
    case "next-pages-router":
      return ["NEXT_PUBLIC_POSTHOG_API_HOST", "NEXT_PUBLIC_POSTHOG_KEY"]
    // Vite bakes the resolved key/host into the injected index.html <script> — no env var.
    case "vite-react":
    case "static-html":
      return []
  }
}

export const posthogProviderAdapter: ProviderAdapter = {
  id: "posthog",
  displayName: "PostHog",
  envKeys(framework) {
    return frameworkEnvKeys(framework)
  },
  plan(framework, artifact, context) {
    const projectKey =
      artifact && typeof artifact === "object" && "projectKey" in artifact
        ? artifact.projectKey
        : undefined
    const apiHost =
      artifact && typeof artifact === "object" && "apiHost" in artifact ? artifact.apiHost : undefined
    const uiHost =
      artifact && typeof artifact === "object" && "uiHost" in artifact ? artifact.uiHost : undefined

    const blockers: string[] = []
    const keyError = validatePosthogProjectKey(projectKey)
    if (keyError) {
      blockers.push(keyError)
    }
    const host = normalizePosthogApiHost(apiHost)
    const apiHostOrigin = "origin" in host ? host.origin : undefined
    if ("error" in host) {
      blockers.push(host.error)
    }

    // ui_host is optional (region-derived by --posthog-proxy) — validate only when present.
    let uiHostOrigin: string | undefined
    if (typeof uiHost === "string" && uiHost.length > 0) {
      const normalizedUiHost = normalizePosthogUiHost(uiHost)
      if ("error" in normalizedUiHost) {
        blockers.push(normalizedUiHost.error)
      } else {
        uiHostOrigin = normalizedUiHost.origin
      }
    }

    const options = artifact && typeof artifact === "object" ? (artifact as PosthogSnippetArtifactOptions) : {}
    // A re-install keeps the bundle the managed snippet already carries: moving it changes what PostHog
    // measures, so only an explicit `defaults` (an approved plan line) moves it. Fresh installs get the
    // current bundle.
    const managedDefaults = context?.managedPosthogDefaults
    const requestedDefaults = options.defaults === undefined ? (managedDefaults ?? POSTHOG_DEFAULTS) : options.defaults
    const defaults =
      requestedDefaults === POSTHOG_PREVIOUS_DEFAULTS ? POSTHOG_PREVIOUS_DEFAULTS : POSTHOG_DEFAULTS
    const defaultsLines: string[] = []
    if (requestedDefaults !== POSTHOG_DEFAULTS && requestedDefaults !== POSTHOG_PREVIOUS_DEFAULTS) {
      blockers.push(
        options.defaults === undefined
          ? `Your managed PostHog carries defaults "${String(requestedDefaults)}", which infinite-tag does not know. Set defaults to "${POSTHOG_DEFAULTS}" or "${POSTHOG_PREVIOUS_DEFAULTS}" explicitly.`
          : `PostHog defaults must be "${POSTHOG_DEFAULTS}" or "${POSTHOG_PREVIOUS_DEFAULTS}".`
      )
    } else if (managedDefaults !== undefined && managedDefaults !== defaults) {
      defaultsLines.push(
        `Measurement changed: PostHog's defaults bundle moves from "${managedDefaults}" to "${defaults}" (PostHog's own pageview and capture settings change with it). Compare before and after across this date, not as growth.`
      )
    } else if (managedDefaults !== undefined && options.defaults === undefined && defaults !== POSTHOG_DEFAULTS) {
      defaultsLines.push(
        `PostHog keeps its defaults bundle "${defaults}" (what your managed install already has). Moving to "${POSTHOG_DEFAULTS}" changes what PostHog measures, so it is its own plan line.`
      )
    }
    const sensitive = normalizeSensitivePaths(options.sensitivePaths)
    if ("error" in sensitive) blockers.push(sensitive.error)
    const guard = resolveArtifactHostGuard(context?.artifacts ?? {})
    if (guard.error) blockers.push(guard.error)
    const snippetOptions: PosthogSnippetOptions = {
      defaults,
      sensitivePaths: "paths" in sensitive ? sensitive.paths : [],
      ...(guard.spec ? { guard: guard.spec } : {})
    }

    const ready = blockers.length === 0 && typeof projectKey === "string" && apiHostOrigin !== undefined
    return {
      assumptions: ready
        ? [
            "PostHog wiring will use only the public projectKey and apiHost artifacts.",
            ...defaultsLines,
            ...(guard.spec
              ? [
                  "PostHog starts only on your production hosts and any host that is not a preview or a laptop: previews (*.vercel.app, *.netlify.app, *.pages.dev) and localhost send nothing."
                ]
              : []),
            ...(snippetOptions.sensitivePaths!.length > 0
              ? [
                  `Session replay and click autocapture are OFF on ${snippetOptions.sensitivePaths!.join(", ")} (set when the page first loads).`
                ]
              : [])
          ]
        : [],
      blockers,
      instructions: ready
        ? [
            {
              path: frameworkInstructionPath(framework),
              action: isHtmlInjectedFramework(framework) ? "modify" : "create",
              description: isHtmlInjectedFramework(framework)
                ? "Inject the PostHog public bootstrap snippet into index.html."
                : "Add the PostHog public bootstrap snippet to the managed analytics module.",
              provider: "posthog",
              snippet: isHtmlInjectedFramework(framework)
                ? wrapHtmlSnippet(buildPostHogBootstrapSnippet(projectKey!, apiHostOrigin!, uiHostOrigin, snippetOptions))
                : buildPostHogBootstrapSnippet(projectKey!, apiHostOrigin!, uiHostOrigin, snippetOptions)
            }
          ]
        : []
    }
  }
}

function frameworkInstructionPath(framework: SupportedFramework): string {
  switch (framework) {
    case "static-html":
    case "vite-react":
      return "index.html"
    case "next-app-router":
    case "next-pages-router":
      return "lib/infinite-analytics.ts"
  }
}

/**
 * THE STUB METHOD LIST: PostHog's current official snippet list, copied from infinite.fast
 * (infinite-site inject-analytics.cjs at 9f65b47). Every name is top-level, so the stub cannot throw
 * while it is built (see the comment in `buildPostHogBootstrapSnippet`).
 */
export const POSTHOG_STUB_METHODS = [
  "init", "capture", "register", "register_once", "register_for_session", "unregister", "unregister_for_session",
  "getFeatureFlag", "getFeatureFlagPayload", "isFeatureEnabled", "reloadFeatureFlags",
  "updateEarlyAccessFeatureEnrollment", "getEarlyAccessFeatures", "on", "onFeatureFlags", "onSessionId", "getSurveys",
  "getActiveMatchingSurveys", "renderSurvey", "canRenderSurvey", "getNextSurveyStep", "identify", "setPersonProperties",
  "group", "resetGroups", "setPersonPropertiesForFlags", "resetPersonPropertiesForFlags", "setGroupPropertiesForFlags",
  "reset", "get_distinct_id", "getGroups", "get_session_id", "get_session_replay_url", "alias", "set_config",
  "startSessionRecording", "stopSessionRecording", "sessionRecordingStarted", "captureException", "loadToolbar",
  "get_property", "getSessionProperty", "createPersonProfile", "opt_in_capturing", "opt_out_capturing",
  "has_opted_in_capturing", "has_opted_out_capturing", "clear_opt_in_out_capturing", "debug"
] as const

/**
 * On a host the preview guard silences, `init` never runs, so the stub's methods are never created and a
 * site's own `posthog.identify(...)` would throw. This defines each one as the stub would — the call is
 * QUEUED in memory — without ever inserting array.js: nothing is loaded and nothing is sent.
 */
function posthogQueueOnlyStub(): string {
  return [
    `var infinitePosthogMethods = '${POSTHOG_STUB_METHODS.filter((name) => name !== "init").join(" ")}'.split(' ');`,
    "for (var infiniteIndex = 0; infiniteIndex < infinitePosthogMethods.length; infiniteIndex += 1) (function (name) {",
    "  if (typeof posthog[name] !== 'function') posthog[name] = function () { posthog.push([name].concat(Array.prototype.slice.call(arguments, 0))); };",
    "})(infinitePosthogMethods[infiniteIndex]);"
  ].join("\n")
}

/**
 * The `defaults` value the site's MANAGED PostHog snippet carries today, read from the managed files the
 * previous manifest lists. Undefined when the manifest has no managed PostHog. A managed PostHog whose
 * files no longer show a value is treated as the bundle every published install before 0.12 carried.
 */
export function managedPosthogDefaults(
  root: string,
  previous: { providers: readonly string[]; files: readonly string[] } | null | undefined
): string | undefined {
  if (!previous || !previous.providers.includes("posthog")) return undefined
  for (const file of previous.files) {
    let contents: string
    try {
      contents = readFileSync(join(root, file), "utf8")
    } catch {
      continue
    }
    if (!contents.includes("posthog.init")) continue
    const match = /defaults: '([0-9]{4}-[0-9]{2}-[0-9]{2})'/.exec(contents)
    if (match) return match[1]
  }
  return POSTHOG_PREVIOUS_DEFAULTS
}

/** PostHog's `defaults` bundle for every new managed install (infinite.fast's value, inject L349). */
export const POSTHOG_DEFAULTS = "2026-01-30"
/** The bundle managed installs carried before 0.12; a re-install keeps it until the user approves the move. */
export const POSTHOG_PREVIOUS_DEFAULTS = "2025-05-24"

interface PosthogSnippetArtifactOptions {
  defaults?: unknown
  sensitivePaths?: unknown
}

export interface PosthogSnippetOptions {
  /** Default `POSTHOG_DEFAULTS`. */
  defaults?: typeof POSTHOG_DEFAULTS | typeof POSTHOG_PREVIOUS_DEFAULTS
  /** Decision 17: replay and autocapture off on these normalised paths. */
  sensitivePaths?: string[]
  /** The preview guard around `posthog.init` (the stub always loads). */
  guard?: HostGuardSpec
}

/**
 * Decision 17's page list, normalised the way the emitted check compares it: root-relative, no query or
 * hash, a trailing slash dropped (except "/"), de-duplicated and sorted.
 */
export function normalizeSensitivePaths(value: unknown): { paths: string[] } | { error: string } {
  if (value === undefined) return { paths: [] }
  if (!Array.isArray(value)) return { error: "PostHog sensitivePaths must be a list of paths." }
  const paths = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== "string" || !/^\/[A-Za-z0-9._~%/-]*$/.test(raw) || raw.startsWith("//") || raw.length > 256) {
      return { error: `PostHog sensitive path ${JSON.stringify(raw)} must be a root-relative path without query or hash.` }
    }
    paths.add(raw.length > 1 ? raw.replace(/\/+$/, "") || "/" : raw)
  }
  return { paths: [...paths].sort() }
}

export function buildPostHogBootstrapSnippet(
  projectKey: string,
  apiHost: string,
  uiHost?: string,
  options: PosthogSnippetOptions = {}
): string {
  // Under a reverse proxy the api_host is a first-party path (e.g. /ingest); ui_host carries
  // the real PostHog app host so the toolbar/app-links keep working. Both go through jsLiteral
  // so a value can never break out of the <script> string literal.
  //
  // FULL NATIVE bootstrap (0.6.0). PostHog keeps ITS OWN defaults — autocapture, pageview, pageleave,
  // session recording, persistence and opt-in state are PostHog's, exactly as if the founder had pasted
  // PostHog's own snippet — and a provider is never reduced WITHOUT a plan line the user approved
  // (decision 17's sensitive pages are exactly such a line). `defaults` opts into PostHog's default
  // bundle (history-change pageviews included): '2026-01-30' for every new install; a re-install keeps the
  // bundle its managed snippet already carries (`managedPosthogDefaults`, '2025-05-24' before 0.12) until an
  // approved plan line moves it. The Infinite runtime forwards nothing into PostHog and
  // never calls set_config / opt_in / opt_out on it; conversions reach PostHog because the site's own
  // code calls the managed helpers (decisions 9 and 13).
  //
  // THE PREVIEW GUARD (decision 3) wraps only `posthog.init`. The stub's `init` is what inserts
  // array.js, so no init means no network at all. On a silenced host the stub's methods are defined as
  // queue-only (`posthogQueueOnlyStub`), so a later `posthog.identify(...)` in the site's own code cannot
  // throw: it is queued in memory and never sent.
  //
  // SENSITIVE PAGES (decision 17), infinite.fast's pattern (inject L340-362): the path is read once at
  // init, a trailing slash ignored, and on a listed page `disable_session_recording: true` and
  // `autocapture: false` are set. Every other page keeps PostHog's own defaults — the keys are not even
  // present. (A client-side navigation INTO a listed page keeps the first page's settings: an SPA needs
  // PostHog's own route controls; see the builder note.)
  //
  // THE STUB METHOD LIST is PostHog's current official snippet list, copied from infinite.fast
  // (infinite-site inject-analytics.cjs at 9f65b47). The list it replaced named methods under
  // parents the stub never creates (`person.*`, `group.*`, `feature_flags.*`, `sessionRecording.*`),
  // so building the stub threw before `init` was queued, and it had no top-level `identify`,
  // `alias` or `get_distinct_id`, so a call made before array.js loaded threw too. Every name here
  // is top-level, so the stub cannot throw while it is built. posthog.test.ts executes it.
  const defaults = options.defaults ?? POSTHOG_DEFAULTS
  const initOptions = [
    `api_host: ${jsLiteral(apiHost)}`,
    ...(uiHost ? [`ui_host: ${jsLiteral(uiHost)}`] : []),
    `defaults: '${defaults}'`
  ].join(", ")
  const sensitivePaths = options.sensitivePaths ?? []
  const init =
    sensitivePaths.length > 0
      ? [
          `var INFINITE_SENSITIVE_PATHS = ${jsLiteral(sensitivePaths)};`,
          "var infinitePathHere = location.pathname;",
          "if (infinitePathHere.length > 1 && infinitePathHere.charAt(infinitePathHere.length - 1) === '/') infinitePathHere = infinitePathHere.slice(0, -1);",
          `var infinitePosthogOptions = { ${initOptions} };`,
          "if (INFINITE_SENSITIVE_PATHS.indexOf(infinitePathHere) !== -1) {",
          "  infinitePosthogOptions.disable_session_recording = true;",
          "  infinitePosthogOptions.autocapture = false;",
          "}",
          `posthog.init(${jsLiteral(projectKey)}, infinitePosthogOptions);`
        ].join("\n")
      : `posthog.init(${jsLiteral(projectKey)}, { ${initOptions} });`
  const guardedInit =
    options.guard !== undefined
      ? wrapGuardedSnippet(init, options.guard, posthogQueueOnlyStub())
      : sensitivePaths.length > 0
        ? ["(function () {", init, "})();"].join("\n")
        : init
  return [
    `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split('.');2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement('script')).type='text/javascript',p.crossOrigin='anonymous',p.async=!0,p.src=s.api_host.replace('.i.posthog.com','-assets.i.posthog.com')+'/static/array.js',(r=t.getElementsByTagName('script')[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a='posthog',u.people=u.people||[],u.toString=function(t){var e='posthog';return'posthog'!==a&&(e+='.'+a),t||(e+=' (stub)'),e},u.people.toString=function(){return u.toString(1)+'.people'},o='${POSTHOG_STUB_METHODS.join(" ")}'.split(' '),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);`,
    guardedInit
  ].join("\n")
}

export function wrapHtmlSnippet(source: string): string {
  return ["<script>", source, "</script>"].join("\n")
}
