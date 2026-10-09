// sandboxedSpawn and its profile (lane O6, §3a.9 item 5). The darwin read/network denies are executed
// in t0.test.ts; these cover the pieces every platform relies on, each with a negative.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { buildSandboxProfile, CLI_CREDENTIAL_STORES, defaultDenyReads, minimalChildEnv, sandboxedSpawn, STDIO_GRACE_MS } from "./sandbox.js"

const darwin = process.platform === "darwin"

/** True once `pid` no longer exists (signal 0 → ESRCH), polling for at most `ms`. */
async function diesWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true
      throw error
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe("the sandbox profile", () => {
  it("denies the network only when asked, reads per secret, and EVERY write outside the writable roots (later rules win)", () => {
    const off = buildSandboxProfile({
      denyReads: ["/Users/x/.ssh"],
      denyReadPrefixes: ["/Users/x/.growth-os"],
      network: false,
      writableRoots: ["/tmp/home-x", "/repo"],
      denyWrites: ["/repo/.git"]
    })
    expect(off.split("\n")).toEqual([
      "(version 1)",
      "(allow default)",
      "(deny network*)",
      '(deny file-read* (subpath "/Users/x/.ssh"))',
      '(deny file-read* (regex #"^/Users/x/\\.growth-os"))',
      "(deny file-write*)",
      '(allow file-write* (subpath "/tmp/home-x") (subpath "/repo") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))',
      '(deny file-write* (subpath "/repo/.git"))',
      '(deny file-write* (subpath "/Users/x/.ssh"))',
      '(deny file-write* (regex #"^/Users/x/\\.growth-os"))'
    ])
    expect(buildSandboxProfile({ denyReads: [], network: true, writableRoots: ["/tmp/h"] })).not.toContain("network")
  })

  it("negative: a relative path, a quote or a control character is refused, never written into the profile", () => {
    expect(() => buildSandboxProfile({ denyReads: ["relative/.ssh"], network: false, writableRoots: [] })).toThrow(/absolute/)
    expect(() => buildSandboxProfile({ denyReads: [], denyReadPrefixes: ['/Users/x/"; (allow default'], network: false, writableRoots: [] })).toThrow(/quote/)
    expect(() => buildSandboxProfile({ denyReads: ["/Users/x/\n(allow default)"], network: false, writableRoots: [] })).toThrow(/control/)
    expect(() => buildSandboxProfile({ denyReads: [], network: false, writableRoots: ["relative"] })).toThrow(/absolute/)
    expect(() => buildSandboxProfile({ denyReads: [], network: false, writableRoots: [], denyWrites: ["repo/.git"] })).toThrow(/absolute/)
  })

  it("also denies the CLI credential stores a build with the network on could otherwise read (review O6-R20)", () => {
    const deny = defaultDenyReads({ homes: ["/Users/founder"], growthOsHome: null })
    for (const store of CLI_CREDENTIAL_STORES) expect(deny.paths).toContain(`/Users/founder/${store}`)
    expect(deny.paths).toContain("/Users/founder/Library/Application Support/com.vercel.cli")
    expect(deny.paths).toContain("/Users/founder/.config/gh")
    // negative: an unrelated dotfile is not swept in
    expect(deny.paths).not.toContain("/Users/founder/.zshrc")
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

  it("the deadline holds for the whole tree: a grandchild holding stdout neither hangs the call nor survives it (review O6-R2)", async () => {
    for (const platform of ["linux", process.platform] as const) {
      const started = Date.now()
      // The shell prints the grandchild's pid, then waits on it; the grandchild keeps stdout open.
      const result = await sandboxedSpawn("/bin/sh", ["-c", "sleep 30 & echo $!; wait"], { denyReads: [], network: false, timeoutMs: 400, platform })
      const elapsed = Date.now() - started
      expect(result.timedOut).toBe(true)
      expect(elapsed).toBeLessThan(400 + STDIO_GRACE_MS + 2_000)
      const grandchild = Number.parseInt(result.stdout.trim(), 10)
      expect(grandchild).toBeGreaterThan(0)
      // negative control on the probe itself: our own pid answers signal 0
      expect(() => process.kill(process.pid, 0)).not.toThrow()
      expect(await diesWithin(grandchild, 2_000)).toBe(true)
    }
  })
})

describe.runIf(darwin)("darwin: the profile denies writes outside the temp HOME and the named roots (review O6-R1)", () => {
  const writeTo = (expression: string) => `try{require('fs').writeFileSync(${expression},'x');process.stdout.write('written')}catch(e){process.stdout.write(e.code)}`
  const writer = (target: string) => writeTo(JSON.stringify(target))
  const reader = (target: string) => `try{require('fs').readFileSync(${JSON.stringify(target)},'utf8');process.stdout.write('read')}catch(e){process.stdout.write(e.code)}`
  const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "sbx-write-test-")))

  it("a write outside the temp HOME is EPERM; into the child's own HOME it works", async () => {
    const dir = scratch()
    const outside = join(dir, "planted")
    const denied = await sandboxedSpawn(process.execPath, ["-e", writer(outside)], { denyReads: [], network: false, timeoutMs: 10_000 })
    expect(denied.sandboxed).toBe(true)
    expect(denied.stdout).toBe("EPERM")
    expect(existsSync(outside)).toBe(false)
    const own = await sandboxedSpawn(process.execPath, ["-e", writeTo("require('path').join(process.env.HOME,'ok')")], { denyReads: [], network: false, timeoutMs: 10_000 })
    expect(own.stdout).toBe("written")
    // negative: the same write with the directory named writable succeeds (the deny is the profile's doing)
    const allowed = await sandboxedSpawn(process.execPath, ["-e", writer(outside)], { denyReads: [], network: false, timeoutMs: 10_000, allowWrites: [dir] })
    expect(allowed.stdout).toBe("written")
    expect(readFileSync(outside, "utf8")).toBe("x")
  })

  it("inside a writable root, `denyWrites` (e.g. <root>/.git/hooks) and every deny-read secret stay unwritable", async () => {
    const root = scratch()
    mkdirSync(join(root, ".git", "hooks"), { recursive: true })
    mkdirSync(join(root, ".growth-os"), { recursive: true })
    writeFileSync(join(root, ".growth-os", ".env"), "GROWTH_OS_ENCRYPTION_KEY=original\n")
    const options = { denyReads: [], denyReadPrefixes: [join(root, ".growth-os")], network: false, timeoutMs: 10_000, allowWrites: [root], denyWrites: [join(root, ".git")] }
    const hook = await sandboxedSpawn(process.execPath, ["-e", writer(join(root, ".git", "hooks", "pre-commit"))], options)
    expect(hook.stdout).toBe("EPERM")
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false)
    const clobber = await sandboxedSpawn(process.execPath, ["-e", writer(join(root, ".growth-os", ".env"))], options)
    expect(clobber.stdout).toBe("EPERM")
    expect(readFileSync(join(root, ".growth-os", ".env"), "utf8")).toBe("GROWTH_OS_ENCRYPTION_KEY=original\n")
    const read = await sandboxedSpawn(process.execPath, ["-e", reader(join(root, ".growth-os", ".env"))], options)
    expect(read.stdout).toBe("EPERM")
    // negative: an ordinary file in the same root is writable
    const plain = await sandboxedSpawn(process.execPath, ["-e", writer(join(root, "out.txt"))], options)
    expect(plain.stdout).toBe("written")
  })

  it("a read of a denied secret is EPERM; the same read without the deny works", async () => {
    const home = scratch()
    mkdirSync(join(home, ".growth-os"))
    writeFileSync(join(home, ".growth-os", "x"), "FAKE-secret-for-the-sandbox-test")
    const target = join(home, ".growth-os", "x")
    const deny = defaultDenyReads({ homes: [home], growthOsHome: null })
    const denied = await sandboxedSpawn(process.execPath, ["-e", reader(target)], { denyReads: deny.paths, denyReadPrefixes: deny.prefixes, network: false, timeoutMs: 10_000 })
    expect(denied.stdout).toBe("EPERM")
    const other = defaultDenyReads({ homes: [scratch()], growthOsHome: null })
    const open = await sandboxedSpawn(process.execPath, ["-e", reader(target)], { denyReads: other.paths, denyReadPrefixes: other.prefixes, network: false, timeoutMs: 10_000 })
    expect(open.stdout).toBe("read")
  })
})
