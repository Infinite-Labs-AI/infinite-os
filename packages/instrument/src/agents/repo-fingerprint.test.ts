// The run fingerprint must equal the link fingerprint (O2 `linkSiteFor`, §3a.3; review O3 F13). These are
// O2's own vectors plus the five inputs the review found diverging; each expected value is spelled out as
// the §3a.3 material string, so a drift in either copy fails here and in O2's test alike.
import { createHash } from "node:crypto"
import { mkdirSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { cleanup, tempDir } from "../../test/wizard/repo.js"
import { appRootLabel, normalizeRemote, repoFingerprint } from "./repo-fingerprint.js"

const dirs: string[] = []
afterEach(() => cleanup(...dirs.splice(0)))
const fp = (material: string) => `sha256:${createHash("sha256").update(material, "utf8").digest("hex")}`

describe("normalizeRemote (O2's vectors)", () => {
  it.each([
    ["https://github.com/acme/acme-store.git", "github.com/acme/acme-store"],
    ["https://user:ghp_x@github.com/acme/acme-store.git", "github.com/acme/acme-store"],
    ["https://GitHub.COM/acme/acme-store?x=1#frag", "github.com/acme/acme-store"],
    ["git@github.com:acme/acme-store.git", "github.com/acme/acme-store"],
    ["git@GitLab.com:group/sub/repo", "gitlab.com/group/sub/repo"],
    ["ssh://git@github.com:22/acme/acme-store.git", "github.com/acme/acme-store"],
    ["ssh://git@git.example.com:2222/acme/site.git/", "git.example.com:2222/acme/site"],
    ["https://bitbucket.org/acme/site.GIT", "bitbucket.org/acme/site"],
    ["user:p@ss@github.com:a/b.git", "github.com/a/b"],
    ["https://github.com/Acme/My%20Store.git", "github.com/Acme/My Store"]
  ])("%s → %s", (raw, expected) => {
    expect(normalizeRemote(raw)).toBe(expected)
  })

  it("refuses what it cannot read safely (a file:// remote falls back to the path)", () => {
    expect(normalizeRemote("")).toBeNull()
    expect(normalizeRemote("file:///srv/git/acme.git")).toBeNull()
    expect(normalizeRemote("https://github.com/")).toBeNull()
  })
})

describe("repoFingerprint = the link's fingerprint on the inputs that used to differ", () => {
  it("percent-encoded path, 'apps/web/', an absolute app root, a file:// remote, the plain case", async () => {
    const root = tempDir("infinite-tag-fp-")
    dirs.push(root)
    mkdirSync(join(root, "apps/web"), { recursive: true })
    const real = realpathSync(root)
    expect(await repoFingerprint({ remoteUrl: "https://github.com/Acme/My%20Store.git", root, appRoot: "." })).toBe(fp("github.com/Acme/My Store\n."))
    expect(await repoFingerprint({ remoteUrl: "git@github.com:Acme/acme-store.git", root, appRoot: "apps/web/" })).toBe(fp("github.com/Acme/acme-store\napps/web"))
    expect(await repoFingerprint({ remoteUrl: "git@github.com:Acme/acme-store.git", root, appRoot: join(root, "apps/web") })).toBe(fp("github.com/Acme/acme-store\napps/web"))
    expect(await repoFingerprint({ remoteUrl: "file:///srv/git/acme.git", root, appRoot: "." })).toBe(fp(`path:${real}\n.`))
    expect(await repoFingerprint({ remoteUrl: "git@github.com:Acme/acme-store.git", root, appRoot: "." })).toBe(fp("github.com/Acme/acme-store\n."))
    // Negative: the raw (un-normalised) remote is never the material.
    expect(await repoFingerprint({ remoteUrl: "https://github.com/Acme/My%20Store.git", root, appRoot: "." })).not.toBe(fp("github.com/Acme/My%20Store\n."))
  })

  it("app root labels are repo-relative", () => {
    expect(appRootLabel("/r", "/r/apps/web")).toBe("apps/web")
    expect(appRootLabel("/r", "/r")).toBe(".")
    expect(appRootLabel("/r", "apps/web/")).toBe("apps/web")
    expect(appRootLabel("/r", "")).toBe(".")
  })
})
