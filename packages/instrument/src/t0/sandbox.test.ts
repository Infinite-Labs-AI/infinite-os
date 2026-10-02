// sandboxedSpawn and its profile (lane O6, §3a.9 item 5). The darwin read/network denies are executed
// in t0.test.ts; these cover the pieces every platform relies on, each with a negative.
import { describe, expect, it } from "vitest"

import { buildSandboxProfile, defaultDenyReads, minimalChildEnv, sandboxedSpawn, SandboxUnavailableError } from "./sandbox.js"

describe("the sandbox profile", () => {
  it("denies the network only when asked, and each path as a subtree", () => {
    const off = buildSandboxProfile({ denyReads: ["/Users/x/.ssh"], denyReadPrefixes: ["/Users/x/.growth-os"], network: false })
    expect(off.split("\n")).toEqual([
      "(version 1)",
      "(allow default)",
      "(deny network*)",
      '(deny file-read* (subpath "/Users/x/.ssh"))',
      '(deny file-read* (regex #"^/Users/x/\\.growth-os"))'
    ])
    expect(buildSandboxProfile({ denyReads: [], network: true })).not.toContain("network")
  })

  it("negative: a relative path, a quote or a control character is refused, never written into the profile", () => {
    expect(() => buildSandboxProfile({ denyReads: ["relative/.ssh"], network: false })).toThrow(/absolute/)
    expect(() => buildSandboxProfile({ denyReads: [], denyReadPrefixes: ['/Users/x/"; (allow default'], network: false })).toThrow(/quote/)
    expect(() => buildSandboxProfile({ denyReads: ["/Users/x/\n(allow default)"], network: false })).toThrow(/control/)
  })

  it("covers every §3a.9 secret location under each home, plus GROWTH_OS_HOME and extras", () => {
    const deny = defaultDenyReads({ homes: ["/Users/founder"], growthOsHome: "/opt/growth", extra: ["/Users/founder/Library/Caches/infinite-tag/snapshots"] })
    for (const path of [".codex", ".ssh", ".aws", ".npmrc", ".netrc", "Library/Caches/infinite-tag"]) expect(deny.paths).toContain(`/Users/founder/${path}`)
    for (const prefix of [".growth-os", ".claude", "Library/Application Support/Infinite"]) expect(deny.prefixes).toContain(`/Users/founder/${prefix}`)
    expect(deny.paths).toContain("/opt/growth")
    expect(deny.paths).toContain("/Users/founder/Library/Caches/infinite-tag/snapshots")
    expect(() => defaultDenyReads({ homes: [], extra: ["not/absolute"] })).toThrow(/absolute/)
  })
})

describe("the child's environment", () => {
  it("is minimal: PATH, a throwaway HOME/TMPDIR, and only allowed extras", () => {
    const env = minimalChildEnv("/tmp/home-x", {
      NEXT_TELEMETRY_DISABLED: "1",
      INFINITE_TAG_MCP_TOKEN: "FAKE-TEST-TOKEN-not-a-secret-0000000000000000000",
      GROWTH_OS_HOME: "/Users/x/.growth-os",
      CLAUDECODE: "1",
      GITHUB_TOKEN: "x",
      SSH_AUTH_SOCK: "/tmp/agent"
    })
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "NEXT_TELEMETRY_DISABLED", "NO_COLOR", "PATH", "TMPDIR"])
    expect(env.HOME).toBe("/tmp/home-x")
  })

  it("a real child sees none of the parent's secrets, and a deadline kills it", async () => {
    process.env.INFINITE_TAG_SECRET_FOR_TEST = "FAKE-TEST-TOKEN-not-a-secret-0000000000000000000"
    try {
      const deny = defaultDenyReads({ homes: [], growthOsHome: null })
      const seen = await sandboxedSpawn(process.execPath, ["-e", "process.stdout.write(JSON.stringify({tag:process.env.INFINITE_TAG_SECRET_FOR_TEST||null,home:process.env.HOME}))"], {
        denyReads: deny.paths,
        network: false,
        timeoutMs: 10_000
      })
      const parsed = JSON.parse(seen.stdout) as { tag: string | null; home: string }
      expect(parsed.tag).toBeNull()
      expect(parsed.home).not.toBe(process.env.HOME)
      expect(seen.sandboxed).toBe(process.platform === "darwin")
      const hung = await sandboxedSpawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { denyReads: [], network: false, timeoutMs: 300 })
      expect(hung.timedOut).toBe(true)
      expect(hung.exitCode).toBeNull()
    } finally {
      delete process.env.INFINITE_TAG_SECRET_FOR_TEST
    }
  })

  it("off darwin the child is a plain process and says so (sandboxed:false)", async () => {
    const plain = await sandboxedSpawn(process.execPath, ["-e", "1"], { denyReads: [], network: false, timeoutMs: 10_000, platform: "linux" })
    expect(plain.exitCode).toBe(0)
    expect(plain.sandboxed).toBe(false)
  })

  it("SandboxUnavailableError is a distinct error type (darwin fails closed with it)", () => {
    expect(new SandboxUnavailableError("x")).toBeInstanceOf(Error)
    expect(new SandboxUnavailableError("x").name).toBe("SandboxUnavailableError")
  })
})
