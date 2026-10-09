// The live checks' fetch honours the proxy environment, so the offline E2E's tripwire proxy sees (and
// refuses) any stray read. Loopback servers only: nothing leaves this machine.
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { afterEach, describe, expect, it } from "vitest"

import { envProxyFetch, noProxyMatches, proxyFor } from "./env-proxy-fetch.js"

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function listen(server: Server): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return (server.address() as AddressInfo).port
}

describe("proxyFor / NO_PROXY", () => {
  it("picks HTTPS_PROXY for https and HTTP_PROXY for http; NO_PROXY exempts exact hosts and suffixes", () => {
    const env = { HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:8", NO_PROXY: "127.0.0.1,.internal.test" }
    expect(proxyFor(new URL("https://acme-store.com/"), env)?.port).toBe("9")
    expect(proxyFor(new URL("http://acme-store.com/"), env)?.port).toBe("8")
    expect(proxyFor(new URL("http://127.0.0.1:3000/"), env)).toBeNull()
    expect(proxyFor(new URL("https://api.internal.test/"), env)).toBeNull()
    expect(noProxyMatches("x.example.com", "*")).toBe(true)
    // negative: no proxy set, or an unrelated NO_PROXY entry, changes nothing
    expect(proxyFor(new URL("https://acme-store.com/"), {})).toBeNull()
    expect(noProxyMatches("acme-store.com", "example.com")).toBe(false)
  })
})

describe("envProxyFetch", () => {
  it("an https read goes to the proxy as a CONNECT (a refusing proxy fails it; nothing reaches the site)", async () => {
    const seen: string[] = []
    const proxy = createServer()
    proxy.on("connect", (req: IncomingMessage, socket: Socket) => {
      seen.push(`CONNECT ${req.url}`)
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n")
    })
    const port = await listen(proxy)
    const fetchImpl = envProxyFetch({ HTTPS_PROXY: `http://127.0.0.1:${port}` })
    await expect(fetchImpl("https://acme-store.com/", { redirect: "manual" })).rejects.toThrow(/refused the tunnel/)
    expect(seen).toEqual(["CONNECT acme-store.com:443"])
  })
})
