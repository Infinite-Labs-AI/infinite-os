// §3h.9 of the wizard build plan: the preview-guard deny list, as code. Published byte-identically as
// `packages/instrument/contracts/host-deny-v1.json` (a test asserts it); 1bu-1 vendors that file
// (lane B0) and C3's daily check reads it, so the tag and the cloud classify hosts the same way.
//
// NORMATIVE. Exempt FIRST (decision 3: production always fires). The exempt list a guard is emitted
// with = union(site-source productionHosts, hosting productionDomains + productionAliases, the final
// host observed in `before`'s dry_live). Lane O5 builds the guard from this constant; it never
// hand-copies the lists.

export interface HostDenyList {
  readonly version: 1
  readonly deny: { readonly exact: readonly string[]; readonly suffix: readonly string[] }
  /** The host normalisation every reader applies before matching, in order. */
  readonly normalize: "trim,lowercase,strip-one-trailing-dot"
}

/** Deeply frozen: a sort or push in one lane can never change the list another lane reads. */
export const HOST_DENY_V1: HostDenyList = Object.freeze({
  version: 1,
  deny: Object.freeze({
    exact: Object.freeze(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]),
    suffix: Object.freeze([".localhost", ".local", ".vercel.app", ".netlify.app", ".pages.dev"])
  }),
  normalize: "trim,lowercase,strip-one-trailing-dot"
} as const)

export const HOST_DENY_V1_FILENAME = "host-deny-v1.json" as const

/**
 * The published bytes of `contracts/host-deny-v1.json`: §3h.9 as ONE line plus a trailing newline (208 bytes,
 * sha256 `5ba888c09c73d6d497e41bcb1c1fd9a123e6154f38e3c59b2fd4fcdc5cf74fe8`). 1bu-1 (B0) vendors exactly these
 * bytes and pins that hash, so this file is NOT two-space JSON like the tag-wizard-v1 fixtures.
 */
export function hostDenyFileText(list: HostDenyList = HOST_DENY_V1): string {
  return `${JSON.stringify(list)}\n`
}
export const HOST_DENY_V1_SHA256 = "5ba888c09c73d6d497e41bcb1c1fd9a123e6154f38e3c59b2fd4fcdc5cf74fe8" as const

/** §3h.9 `normalize`: trim, lowercase, strip ONE trailing dot. Every host comparison goes through this first. */
export function normalizeHost(host: string): string {
  const lowered = host.trim().toLowerCase()
  return lowered.endsWith(".") ? lowered.slice(0, -1) : lowered
}
