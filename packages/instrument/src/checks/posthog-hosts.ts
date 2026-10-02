// PostHog host facts shared by the live checks and the setup checks: which cloud region a host is in,
// and whether a served `api_host` fits the connected project's.

/** Null when the served `api_host` fits the expected one; otherwise the problem sentence. */
export function compareApiHost(served: string, expected: string): string | null {
  if (isRelativePath(served)) {
    if (isRelativePath(expected) && served.replace(/\/+$/, "") !== expected.replace(/\/+$/, "")) {
      return `PostHog api_host is ${served}, expected ${expected}`
    }
    return null
  }
  if (isRelativePath(expected)) return `PostHog api_host is ${served}, expected the first-party path ${expected}`
  const servedRegion = posthogRegion(served)
  const expectedRegion = posthogRegion(expected)
  if (servedRegion === "other" || expectedRegion === "other") {
    return originOrSelf(served) === originOrSelf(expected) ? null : `PostHog api_host is ${served}, expected ${expected}`
  }
  if (servedRegion !== expectedRegion) {
    return `PostHog api_host is the ${servedRegion.toUpperCase()} cloud (${served}) but the connected project is in the ${expectedRegion.toUpperCase()} cloud — events go to a project that is not yours`
  }
  return null
}

export function posthogRegion(host: string): "us" | "eu" | "other" {
  let hostname: string
  try {
    hostname = new URL(host).hostname.toLowerCase()
  } catch {
    return "other"
  }
  if (!hostname.endsWith("posthog.com")) return "other"
  if (/(^|\.)eu(-assets)?\.(i\.)?posthog\.com$/.test(hostname)) return "eu"
  if (/(^|\.)(us(-assets)?\.(i\.)?|app\.)posthog\.com$/.test(hostname)) return "us"
  return "other"
}

function originOrSelf(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    return value
  }
}

export function isRelativePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//")
}
