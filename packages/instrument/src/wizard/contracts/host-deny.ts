// §3h.9 of the wizard build plan: the preview-guard deny list, as code. Published byte-identically as
// `packages/instrument/contracts/host-deny-v1.json` (a test asserts it); 1bu-1 vendors that file
// (lane B0) and C3's daily check reads it, so the tag and the cloud classify hosts the same way.
//
// NORMATIVE. Exempt FIRST (decision 3: production always fires). The exempt list a guard is emitted
// with = union(site-source productionHosts, hosting productionDomains + productionAliases, the final
// host observed in `before`'s dry_live). Lane O5 builds the guard from this constant; it never
// hand-copies the lists.

export interface HostDenyList {
  version: 1
  deny: { exact: string[]; suffix: string[] }
  /** The host normalisation every reader applies before matching, in order. */
  normalize: "trim,lowercase,strip-one-trailing-dot"
}

export const HOST_DENY_V1: Readonly<HostDenyList> = Object.freeze({
  version: 1,
  deny: {
    exact: ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"],
    suffix: [".localhost", ".local", ".vercel.app", ".netlify.app", ".pages.dev"]
  },
  normalize: "trim,lowercase,strip-one-trailing-dot"
})

export const HOST_DENY_V1_FILENAME = "host-deny-v1.json" as const
