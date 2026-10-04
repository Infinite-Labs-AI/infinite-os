// The `meta` verification lane. Until now it was a hardcoded
// `{ state: "not_verifiable", reason: "Meta has no install-time read-back" }` — true about RECEIPTS,
// but it meant the harness had nothing at all to say about the one Meta failure we can detect from
// outside: a pixel that Meta has silently stopped accepting sends from.
//
// This lane never mints `verified`. Meta offers no install-time read-back, so the strongest honest
// claim is "delivery is not blocked". What it CAN do is turn a specific, invisible, spend-destroying
// misconfiguration into a `no_receipt` with the remedy in the first cause line.
import { createHash } from "node:crypto"

import type { LaneVerification } from "../harness/verify.js"

import {
  extractMetaPixelIds,
  probeMetaDelivery,
  type MetaDeliveryFinding
} from "./config-probe.js"
import {
  META_NO_PIXEL_ON_PAGE_REASON,
  isMetaDeliveryFailure,
  metaAllowedReason,
  metaDeliveryHeadline
} from "./copy.js"

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

export interface CheckMetaLaneOptions {
  /** The page body the verify step already fetched. No second page load is performed. */
  html: string
  /** The URL that body came from; its hostname is the domain Meta scopes the config to. */
  url: string
  version: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface MetaLaneResult {
  verification: LaneVerification
  findings: MetaDeliveryFinding[]
}

/**
 * Probe every pixel the page initialises, then collapse to ONE lane answer.
 *
 * Collapse order is worst-first and deliberate: with two pixels on a page, one blocked and one fine,
 * the answer is BLOCKED. Averaging them, or letting the healthy one win, would hide exactly the
 * situation a customer most needs told — and a site migrating between pixels is when this bug
 * actually happens, because the allow list follows the old domain.
 */
export async function checkMetaLane(options: CheckMetaLaneOptions): Promise<MetaLaneResult> {
  let domain: string
  try {
    domain = new URL(options.url).hostname
  } catch {
    return {
      verification: {
        state: "not_verifiable",
        reason: `the verified URL (${options.url}) has no readable hostname, so Meta's domain-scoped config cannot be requested`
      },
      findings: []
    }
  }

  const pixelIds = extractMetaPixelIds(options.html)
  if (pixelIds.length === 0) {
    return { verification: { state: "not_verifiable", reason: META_NO_PIXEL_ON_PAGE_REASON }, findings: [] }
  }

  const findings: MetaDeliveryFinding[] = []
  for (const pixelId of pixelIds) {
    findings.push(
      await probeMetaDelivery({
        pixelId,
        domain,
        version: options.version,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        sha256Hex
      })
    )
  }

  const failures = findings.filter(isMetaDeliveryFailure)
  if (failures.length > 0) {
    // `no_receipt` is the right shape: these pixels will never produce a receipt from this domain,
    // and its `causes` list is what the report prints. The remedy leads.
    const others = findings.filter((finding) => !isMetaDeliveryFailure(finding))
    return {
      verification: {
        state: "no_receipt",
        causes: [...failures, ...others].map(metaDeliveryHeadline)
      },
      findings
    }
  }

  const unknowns = findings.filter((finding) => finding.kind === "unknown")
  if (unknowns.length > 0) {
    // A probe that could not run is reported as exactly that. Never fold it into the allowed case:
    // a false green here is worse than no check, because it is the same silence as the bug.
    return {
      verification: { state: "not_verifiable", reason: unknowns.map(metaDeliveryHeadline).join(" ") },
      findings
    }
  }

  return { verification: { state: "not_verifiable", reason: metaAllowedReason(findings) }, findings }
}
