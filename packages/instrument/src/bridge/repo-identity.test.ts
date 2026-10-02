import { describe, expect, it } from "vitest"

import { appRootLabel, folderLabel, linkSiteFor, normalizeRemote, repoFingerprint, sha256Hex } from "./repo-identity.js"

describe("normalizeRemote", () => {
  it.each([
    ["https://github.com/acme/acme-store.git", "github.com/acme/acme-store"],
    ["https://user:ghp_x@github.com/acme/acme-store.git", "github.com/acme/acme-store"],
    ["https://GitHub.COM/acme/acme-store?x=1#frag", "github.com/acme/acme-store"],
    ["git@github.com:acme/acme-store.git", "github.com/acme/acme-store"],
    ["git@GitLab.com:group/sub/repo", "gitlab.com/group/sub/repo"],
    ["ssh://git@github.com:22/acme/acme-store.git", "github.com/acme/acme-store"],
    ["ssh://git@git.example.com:2222/acme/site.git/", "git.example.com:2222/acme/site"],
    ["https://bitbucket.org/acme/site.GIT", "bitbucket.org/acme/site"]
  ])("%s → %s", (raw, expected) => {
    expect(normalizeRemote(raw)).toBe(expected)
  })

  it("refuses remotes it cannot read safely", () => {
    expect(normalizeRemote("")).toBeNull()
    expect(normalizeRemote("file:///tmp/repo")).toBeNull()
    expect(normalizeRemote("https://github.com/")).toBeNull()
  })
})

describe("linkSiteFor", () => {
  it("never lets a credentialed remote reach the label or the fingerprint input", () => {
    const raw = "https://user:ghp_x@github.com/a/b.git"
    const site = linkSiteFor({ rawRemote: raw, realRoot: "/Users/founder/Github/b", root: "/Users/founder/Github/b", appRoot: ".", productionHostHint: null, homeDir: "/Users/founder" })
    expect(site.repoLabel).toBe("github.com/a/b")
    const serialized = JSON.stringify(site)
    expect(serialized).not.toContain("ghp_")
    expect(serialized).not.toContain("user")
    expect(site.repoFingerprint).toBe(`sha256:${sha256Hex("github.com/a/b\n.")}`)
    // Negative: hashing the raw remote would give another fingerprint.
    expect(site.repoFingerprint).not.toBe(`sha256:${sha256Hex(`${raw}\n.`)}`)
  })

  it("falls back to the real path when there is no remote", () => {
    const site = linkSiteFor({ rawRemote: null, realRoot: "/Users/founder/Github/b", root: "/Users/founder/Github/b", appRoot: "apps/web", productionHostHint: "b.com", homeDir: "/Users/founder" })
    expect(site.repoFingerprint).toBe(repoFingerprint({ normalizedRemote: null, realRoot: "/Users/founder/Github/b", appRoot: "apps/web" }))
    expect(site.repoFingerprint).toBe(`sha256:${sha256Hex("path:/Users/founder/Github/b\napps/web")}`)
    expect(site.repoLabel).toBe("~/Github/b")
    expect(site.folderLabel).toBe("~/Github/b")
    expect(site.productionHostHint).toBe("b.com")
  })

  it("the app root changes the fingerprint", () => {
    const a = repoFingerprint({ normalizedRemote: "github.com/a/b", realRoot: "/x", appRoot: "." })
    const b = repoFingerprint({ normalizedRemote: "github.com/a/b", realRoot: "/x", appRoot: "apps/web" })
    expect(a).not.toBe(b)
  })
})

describe("normalizeRemote: no part of a credential in the host (scp form)", () => {
  it("a password holding '@' in an scp-like remote never leaks into the label", () => {
    expect(normalizeRemote("user:p@ss@github.com:a/b.git")).toBe("github.com/a/b")
    expect(normalizeRemote("a@b@github.com:acme/site.git")).toBe("github.com/acme/site")
    // An '@' in the PATH is kept (it is not userinfo).
    expect(normalizeRemote("git@github.com:org/re@po.git")).toBe("github.com/org/re@po")
    expect(normalizeRemote("git@github.com:acme/acme-store.git")).toBe("github.com/acme/acme-store")
  })
})

describe("labels", () => {
  it("shortens the home prefix only", () => {
    expect(folderLabel("/Users/founder/Github/acme", "/Users/founder")).toBe("~/Github/acme")
    expect(folderLabel("/srv/acme", "/Users/founder")).toBe("/srv/acme")
    expect(folderLabel("/Users/founderx/acme", "/Users/founder")).toBe("/Users/founderx/acme")
  })

  it("app root labels are repo-relative", () => {
    expect(appRootLabel("/r", "/r/apps/web")).toBe("apps/web")
    expect(appRootLabel("/r", "/r")).toBe(".")
    expect(appRootLabel("/r", "apps/web/")).toBe("apps/web")
    expect(appRootLabel("/r", "")).toBe(".")
  })
})
