import type { InstallInstruction, ProviderAdapter, SupportedFramework } from "../types.js"
import { jsLiteral, normalizePosthogApiHost, validatePosthogProjectKey } from "./validate.js"

function frameworkEnvKeys(framework: SupportedFramework): string[] {
  switch (framework) {
    case "next-app-router":
    case "next-pages-router":
      return ["NEXT_PUBLIC_POSTHOG_API_HOST", "NEXT_PUBLIC_POSTHOG_KEY"]
    case "vite-react":
      return ["VITE_POSTHOG_API_HOST", "VITE_POSTHOG_KEY"]
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
  plan(framework, artifact) {
    const projectKey =
      artifact && typeof artifact === "object" && "projectKey" in artifact
        ? artifact.projectKey
        : undefined
    const apiHost =
      artifact && typeof artifact === "object" && "apiHost" in artifact ? artifact.apiHost : undefined

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

    const ready = blockers.length === 0 && typeof projectKey === "string" && apiHostOrigin !== undefined
    return {
      assumptions: ready
        ? ["PostHog wiring will use only the public projectKey and apiHost artifacts."]
        : [],
      blockers,
      instructions: ready
        ? [
            {
              path: frameworkInstructionPath(framework),
              action: framework === "static-html" ? "modify" : "create",
              description:
                framework === "static-html"
                  ? "Inject the PostHog public bootstrap snippet into index.html."
                  : "Add the PostHog public bootstrap snippet to the managed analytics module.",
              provider: "posthog",
              snippet:
                framework === "static-html"
                  ? wrapHtmlSnippet(buildBootstrapSnippet(projectKey!, apiHostOrigin!))
                  : buildBootstrapSnippet(projectKey!, apiHostOrigin!)
            }
          ]
        : []
    }
  }
}

function frameworkInstructionPath(framework: SupportedFramework): string {
  switch (framework) {
    case "static-html":
      return "index.html"
    case "vite-react":
      return "src/lib/infinite-analytics.ts"
    case "next-app-router":
    case "next-pages-router":
      return "lib/infinite-analytics.ts"
  }
}

function buildBootstrapSnippet(projectKey: string, apiHost: string): string {
  return [
    "!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split('.');2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement('script')).type='text/javascript',p.crossOrigin='anonymous',p.async=!0,p.src=s.api_host.replace('.i.posthog.com','-assets.i.posthog.com')+'/static/array.js',(r=t.getElementsByTagName('script')[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a='posthog',u.people=u.people||[],u.toString=function(t){var e='posthog';return'posthog'!==a&&(e+='.'+a),t||(e+=' (stub)'),e},u.people.toString=function(){return u.toString(1)+'.people'},o='init capture register register_once unregister reset opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing set_config people.set people.set_once people.unset people.increment people.append people.union people.track_charge people.clear_charges people.delete_user people.remove_group people.set person.set_once person.unset person.increment person.append person.union person.track_charge person.clear_charges person.delete_user group.set group.set_once group.unset group.remove group.union group.track group.identify group.set_property feature_flags.isFeatureEnabled feature_flags.getFeatureFlag feature_flags.getFeatureFlagPayload feature_flags.reloadFeatureFlags feature_flags.updateEarlyAccessFeatureEnrollment feature_flags.getEarlyAccessFeatures feature_flags.onFeatureFlags sessionRecording.startSessionRecording sessionRecording.stopSessionRecording sessionRecording.getSessionRecordingUrl'.split(' '),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);",
    `posthog.init(${jsLiteral(projectKey)}, { api_host: ${jsLiteral(apiHost)}, persistence: 'localStorage+cookie' });`
  ].join("\n")
}

function wrapHtmlSnippet(source: string): string {
  return ["<script>", source, "</script>"].join("\n")
}
