// §3a.3 `repoFingerprint` for the run record the `agent` step starts (POST /v1/runs). It MUST equal the
// link's fingerprint, so there is ONE copy of the rule (§3z.12 B9): lane O2's `bridge/repo-identity.ts`.
// This module only resolves the repo's realpath for the no-remote form.
import { realpath } from "node:fs/promises"

import { appRootLabel, normalizeRemote, repoFingerprint as fingerprintOf } from "../bridge/repo-identity.js"

export { appRootLabel, normalizeRemote }

export async function repoFingerprint(input: { remoteUrl: string | null; root: string; appRoot: string }): Promise<string> {
  const normalizedRemote = input.remoteUrl !== null ? normalizeRemote(input.remoteUrl) : null
  return fingerprintOf({
    normalizedRemote,
    realRoot: normalizedRemote === null ? await realpath(input.root) : input.root,
    appRoot: appRootLabel(input.root, input.appRoot)
  })
}
