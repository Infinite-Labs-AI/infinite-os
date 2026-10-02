// The real wiring (lane I1): `createDefaultWizardDeps` registers lane O9's checks on lane O6's runner, and the
// live reads go through the proxy-aware fetch. A loopback proxy that refuses every tunnel stands in for the
// network: nothing leaves this machine, and no app, agent or gh is started.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { O9_CHECK_IDS } from "../checks/o9.js"
import type { O6CheckRunner } from "../checks/registry.js"
import { parseWizardArgs } from "./command.js"
import { createDefaultWizardDeps } from "./deps.js"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function site(): { root: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), "infinite-tag-deps-"))
  dirs.push(base)
  const root = join(base, "site")
  const home = join(base, "home")
  mkdirSync(root)
  mkdirSync(home)
  execFileSync("git", ["init", "-q", root])
  return { root, home }
}

async function deps(env: Record<string, string>, fetch?: typeof globalThis.fetch) {
  const { root, home } = site()
  const parsed = parseWizardArgs(["--json"], root)
  if (!parsed.ok) throw new Error(parsed.message)
  const controller = new AbortController()
  return createDefaultWizardDeps(
    { root, appRoot: ".", options: parsed.value.options, env: { ...env, HOME: home, GROWTH_OS_HOME: join(home, ".growth-os") }, platform: "darwin", tagVersion: "0.12.0-test", signal: controller.signal },
    { home, ...(fetch ? { fetch } : {}) }
  )
}

describe("createDefaultWizardDeps (I1 wiring)", () => {
  it("registers every O9 check on O6's runner (the seams the steps call resolve to O9's functions)", async () => {
    const wired = await deps({})
    const registered = (wired.checks as O6CheckRunner).registered()
    for (const id of Object.values(O9_CHECK_IDS)) expect(registered).toContain(id)
  })

  it("live reads honour HTTPS_PROXY: a refusing proxy sees the CONNECT, the walk reads undetermined (never a pass)", async () => {
    const connects: string[] = []
    const proxy = createServer()
    proxy.on("connect", (request: IncomingMessage, socket: Socket) => {
      connects.push(String(request.url))
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n")
    })
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
    try {
      const wired = await deps({ HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` })
      const results = await wired.checks.redirectWalk(["https://acme-store.com/"])
      expect(connects.length).toBeGreaterThan(0)
      expect(connects.every((target) => target === "acme-store.com:443")).toBe(true)
      expect(results.length).toBeGreaterThan(0)
      expect(results.every((result) => result.state !== "pass")).toBe(true)
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    }
  })

  it("NEGATIVE: an injected fetch replaces the network entirely (no proxy, no socket)", async () => {
    const seen: string[] = []
    const fetchSpy = (async (input: string | URL | Request) => {
      seen.push(String(input instanceof Request ? input.url : input))
      return new Response("", { status: 200, headers: { "content-type": "text/html" } })
    }) as typeof globalThis.fetch
    const wired = await deps({ HTTPS_PROXY: "http://127.0.0.1:9" }, fetchSpy)
    await wired.checks.redirectWalk(["https://acme-store.com/"])
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((url) => url.startsWith("https://acme-store.com/"))).toBe(true)
  })
})
