// T1 `meta_traffic_permissions` + `meta_host_matrix`: will Meta ACCEPT this pixel's sends from these
// domains?
//
// Incident guarded (PORT-PLAN §4, 2026-09-20, ecff171): the pixel on infinite.fast looked healthy from
// every angle — Pixel Helper green, fbevents.js and the signals config 200, `fbq.getState()` listing it
// — and had never sent one `/tr` beacon, because the pixel's Traffic Permissions allow list named only
// the pre-rebrand domain. The veto ships as data in the pixel's DOMAIN-SCOPED config, so it can be read
// from outside with no credentials (`meta-live/config-probe.ts`, `probeMetaDelivery`).
//
// Incident guarded (b714a65): a parser that folded "could not read the directive" into "absent" turned
// a broken probe into a pass. Here `unknown` is `undetermined`, never `pass`.
//
// Two generalisations over the harness's `meta` lane (`meta-live/lane.ts`):
//   • the pixel ids come from the CONNECTION and from `signals/config/<id>` requests the test window
//     observed (a pixel booted from a `useEffect` or by GTM never shows in the HTML) — never from a
//     default;
//   • one probe per REGISTRABLE domain (Meta matches the allow list on the registrable domain, so apex
//     and www are the same answer).
// `meta_host_matrix` adds the second layer of the Meta preview defence (port plan row 1): the same probe
// for a PREVIEW host should come back blocked. "Delivery not blocked" is the strongest wording — never
// "verified".
import { createHash } from "node:crypto"

import { probeMetaDelivery, type MetaDeliveryFinding } from "../../meta-live/config-probe.js"
import type { CheckContext, CheckResult } from "../../wizard/contracts/jobs.js"
import { normalizeHost } from "../../wizard/contracts/host-deny.js"
import { checkResult, maskIdentifier } from "../result.js"

import { isDeniedHost, registrableDomain } from "./hosts.js"
import type { LiveFetch, LiveProbeDeps } from "./probe.js"

export const META_TRAFFIC_PERMISSIONS_CHECK_ID = "meta_traffic_permissions" as const
export const META_HOST_MATRIX_CHECK_ID = "meta_host_matrix" as const

const PIXEL_ID = /^[0-9]{15,16}$/

export interface MetaDomainsInput {
  /** Production hosts the pixel runs on (site source hosts, hosting domains, the observed final host). */
  domains: readonly string[]
  /** Pixel ids from the connection (keys verb) or from flags / `install.json` `ids`. */
  pixelIds: readonly string[]
  /** Pixel ids seen in `signals/config/<id>` requests during the test window's load. */
  observedConfigPixelIds?: readonly string[]
  /** Preview hosts to probe for the host matrix (each should come back blocked). */
  previewHosts?: readonly string[]
}

/** Every probe declares itself a check; the Meta CDN ignores it, but the rule is uniform on purpose. */
function prefetchFetch(base: LiveFetch | undefined): LiveFetch {
  const fetchImpl = base ?? globalThis.fetch
  return ((url: string | URL | Request, init?: RequestInit) =>
    fetchImpl(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), Purpose: "prefetch" } })) as LiveFetch
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

export async function checkMetaDomains(
  input: MetaDomainsInput,
  deps: LiveProbeDeps,
  ctx: Pick<CheckContext, "runId" | "now">
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const ids = [...new Set([...input.pixelIds, ...(input.observedConfigPixelIds ?? [])])]
  const valid = ids.filter((id) => PIXEL_ID.test(id))
  for (const invalid of ids.filter((id) => !PIXEL_ID.test(id))) {
    results.push(
      checkResult(META_TRAFFIC_PERMISSIONS_CHECK_ID, "info", "T1", ctx, {
        reason: `${maskIdentifier(invalid)} is not a Meta pixel id (15 or 16 digits), so it was not probed`
      })
    )
  }
  if (valid.length === 0) {
    results.push(
      checkResult(META_TRAFFIC_PERMISSIONS_CHECK_ID, "undetermined", "T1", ctx, {
        reason: "not_connected: no Meta pixel id from the connection or the page, so delivery was not probed"
      })
    )
    return results
  }
  const fetchImpl = prefetchFetch(deps.fetch)
  const probe = (pixelId: string, domain: string): Promise<MetaDeliveryFinding> =>
    probeMetaDelivery({ pixelId, domain, version: deps.version, fetch: fetchImpl, sha256Hex, ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) })

  // One probe per registrable domain; preview-shaped hosts are never "production" domains here.
  const productionHosts = new Map<string, string>()
  for (const raw of input.domains) {
    const host = normalizeHost(raw)
    if (!host || isDeniedHost(host)) continue
    const key = registrableDomain(host)
    if (!productionHosts.has(key)) productionHosts.set(key, host)
  }
  if (productionHosts.size === 0) {
    results.push(
      checkResult(META_TRAFFIC_PERMISSIONS_CHECK_ID, "undetermined", "T1", ctx, {
        reason: "no production domain to probe (only preview or local hosts were given)"
      })
    )
  }
  for (const pixelId of valid) {
    for (const host of productionHosts.values()) {
      const finding = await probe(pixelId, host)
      results.push(findingResult(finding, ctx))
    }
  }

  const previews = [...new Set((input.previewHosts ?? []).map(normalizeHost).filter(Boolean))]
  for (const pixelId of valid) {
    for (const host of previews) {
      const finding = await probe(pixelId, host)
      results.push(hostMatrixResult(finding, ctx))
    }
  }
  return results
}

function findingResult(finding: MetaDeliveryFinding, ctx: Pick<CheckContext, "runId" | "now">): CheckResult {
  const where = `pixel ${maskIdentifier(finding.pixelId)} on ${finding.domain}`
  const evidence = [{ url: `https://${finding.domain}/` }]
  switch (finding.kind) {
    case "allowed":
      return checkResult(META_TRAFFIC_PERMISSIONS_CHECK_ID, "pass", "T1", ctx, {
        reason: `${where}: delivery not blocked (Meta serves no block directive for this domain)`,
        evidence
      })
    case "blocked":
      return checkResult(META_TRAFFIC_PERMISSIONS_CHECK_ID, "problem", "T1", ctx, {
        reason: `${where} is BLOCKED FROM TRANSMITTING (blockReason=${finding.blockReason}): add ${finding.domain} to the pixel's Traffic Permissions allow list in Events Manager`,
        evidence
      })
    case "source_blocked":
      return checkResult(META_TRAFFIC_PERMISSIONS_CHECK_ID, "problem", "T1", ctx, {
        reason: `${finding.domain} is on ${where.replace(` on ${finding.domain}`, "")}'s BLOCK list: remove it in Events Manager > Settings > Traffic permissions`,
        evidence
      })
    case "pixel_not_found":
      return checkResult(META_TRAFFIC_PERMISSIONS_CHECK_ID, "problem", "T1", ctx, {
        reason: `Meta serves no config for ${where}: the pixel id does not exist`,
        evidence
      })
    case "unknown":
      return checkResult(META_TRAFFIC_PERMISSIONS_CHECK_ID, "undetermined", "T1", ctx, {
        reason: `${where}: the probe could not tell (${finding.detail}); this is not a pass`,
        evidence
      })
  }
}

function hostMatrixResult(finding: MetaDeliveryFinding, ctx: Pick<CheckContext, "runId" | "now">): CheckResult {
  const where = `pixel ${maskIdentifier(finding.pixelId)} on the preview host ${finding.domain}`
  const evidence = [{ url: `https://${finding.domain}/` }]
  switch (finding.kind) {
    case "blocked":
    case "source_blocked":
      return checkResult(META_HOST_MATRIX_CHECK_ID, "pass", "T1", ctx, {
        reason: `${where} is refused by Traffic Permissions, so previews cannot send to the real pixel`,
        evidence
      })
    case "allowed":
      // Not a defect on its own: the runtime guard (decision 8) is the other layer. Shown as a plan line.
      return checkResult(META_HOST_MATRIX_CHECK_ID, "info", "T1", ctx, {
        reason: `${where} is ALLOWED: Traffic Permissions do not limit the pixel to your domain, so the page guard is the only thing keeping previews out`,
        evidence
      })
    case "pixel_not_found":
      return checkResult(META_HOST_MATRIX_CHECK_ID, "problem", "T1", ctx, {
        reason: `Meta serves no config for pixel ${maskIdentifier(finding.pixelId)}: the pixel id does not exist`,
        evidence
      })
    case "unknown":
      return checkResult(META_HOST_MATRIX_CHECK_ID, "undetermined", "T1", ctx, {
        reason: `${where}: the probe could not tell (${finding.detail})`,
        evidence
      })
  }
}
