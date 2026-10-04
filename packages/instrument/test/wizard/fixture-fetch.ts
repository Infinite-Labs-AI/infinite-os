// Test doubles for the live checks: no test ever reaches the real network.
//
// `fixtureFetch` answers from a route table and records every request (method, URL, headers), so a test
// can assert that EVERY probe carried `Purpose: prefetch`. `loopbackSite` is a real HTTP server on
// 127.0.0.1 behind a fetch that maps an https site origin onto it, for end-to-end runs that exercise
// real headers and manual redirects.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
}

export interface FixtureRoute {
  status?: number
  body?: string
  headers?: Record<string, string>
}

export type FixtureHandler = FixtureRoute | ((request: RecordedRequest) => FixtureRoute)

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

/**
 * A fetch over a route table keyed by exact URL, else by origin + pathname. An unknown URL is a network
 * error (a TypeError, as fetch throws), so a forgotten route can never read as a pass.
 */
export function fixtureFetch(routes: Record<string, FixtureHandler>): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const request: RecordedRequest = { method: (init?.method ?? "GET").toUpperCase(), url, headers: headersOf(init) }
    requests.push(request)
    const parsed = new URL(url)
    const handler = routes[url] ?? routes[`${parsed.origin}${parsed.pathname}`]
    if (handler === undefined) throw new TypeError(`fetch failed (fixture: no route for ${request.method} ${url})`)
    const route = typeof handler === "function" ? handler(request) : handler
    const status = route.status ?? 200
    const body = request.method === "HEAD" || status === 204 || status === 304 ? null : (route.body ?? "")
    const response = new Response(body, { status, headers: route.headers ?? {} })
    Object.defineProperty(response, "url", { value: url })
    return response
  }) as typeof fetch
  return { fetch: fetchImpl, requests }
}

export interface LoopbackSite {
  /** The https origin the checks are pointed at (e.g. `https://acme-store.test`). */
  siteOrigin: string
  /** A fetch that sends `siteOrigin` requests to the loopback server and fails every other host. */
  fetch: typeof fetch
  requests: RecordedRequest[]
  close(): Promise<void>
}

export async function loopbackSite(
  siteOrigin: string,
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<LoopbackSite> {
  const requests: RecordedRequest[] = []
  const server = createServer((request, response) => {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers[key] = value
    requests.push({ method: request.method ?? "GET", url: `${siteOrigin}${request.url ?? "/"}`, headers })
    handler(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== siteOrigin) throw new TypeError(`fetch failed (loopback: ${url.origin} is not the fixture site)`)
    const target = `http://127.0.0.1:${port}${url.pathname}${url.search}`
    const response = await fetch(target, init)
    Object.defineProperty(response, "url", { value: response.url.replace(`http://127.0.0.1:${port}`, siteOrigin) })
    return response
  }) as typeof fetch
  return {
    siteOrigin,
    fetch: fetchImpl,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** A fixed clock for check results. */
export const FIXED_NOW = () => new Date("2026-10-02T12:00:00.000Z")
