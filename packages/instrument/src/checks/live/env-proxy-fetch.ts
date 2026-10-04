// The live checks' fetch, honouring the standard proxy environment (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`,
// their lowercase forms, and `NO_PROXY`). Node's built-in fetch ignores them, so behind a company proxy the
// read-only T1 checks would bypass it, and the wizard's offline end-to-end test (§4.3) could not prove that
// nothing reached any network (its proxy is a tripwire that refuses and counts). Zero dependencies:
// plain `http://` proxies only (CONNECT for https targets); an `https://` or authenticated proxy is used as
// given (credentials in the proxy URL become a Basic `Proxy-Authorization`).
//
// The answer is buffered (capped) and handed back as a standard `Response`; redirects are never followed
// here (every caller asks for `redirect: "manual"` and walks hops itself).
import { request as httpRequest, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import { connect as tlsConnect } from "node:tls"

import type { LiveFetch } from "./probe.js"

/** Bodies above this are cut (the probes read at most 4 MB). */
const MAX_PROXIED_BYTES = 8 * 1024 * 1024

type Env = Readonly<Record<string, string | undefined>>

function envValue(env: Env, name: string): string | undefined {
  const value = env[name] ?? env[name.toLowerCase()]
  return value && value.trim() !== "" ? value.trim() : undefined
}

/** True when `NO_PROXY` exempts the host (`*`, an exact host, or a domain suffix with or without a dot). */
export function noProxyMatches(host: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false
  const target = host.toLowerCase().replace(/^\[|\]$/g, "")
  for (const raw of noProxy.split(",")) {
    const entry = raw.trim().toLowerCase().replace(/:\d+$/, "")
    if (entry === "") continue
    if (entry === "*") return true
    const bare = entry.replace(/^\*?\./, "")
    if (target === bare || target.endsWith(`.${bare}`)) return true
  }
  return false
}

/** The proxy URL for a target URL, or null (none set, or NO_PROXY exempts it). */
export function proxyFor(target: URL, env: Env): URL | null {
  if (noProxyMatches(target.hostname, envValue(env, "NO_PROXY"))) return null
  const raw = target.protocol === "https:" ? (envValue(env, "HTTPS_PROXY") ?? envValue(env, "ALL_PROXY")) : (envValue(env, "HTTP_PROXY") ?? envValue(env, "ALL_PROXY"))
  if (!raw) return null
  try {
    const proxy = new URL(raw.includes("://") ? raw : `http://${raw}`)
    return proxy.protocol === "http:" || proxy.protocol === "https:" ? proxy : null
  } catch {
    return null
  }
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, key) => {
    out[key] = value
  })
  return out
}

function proxyAuth(proxy: URL): Record<string, string> {
  if (!proxy.username) return {}
  const user = decodeURIComponent(proxy.username)
  const pass = decodeURIComponent(proxy.password)
  return { "Proxy-Authorization": `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` }
}

function toResponse(message: IncomingMessage, url: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    message.on("data", (chunk: Buffer) => {
      if (size >= MAX_PROXIED_BYTES) return
      size += chunk.length
      chunks.push(chunk)
    })
    message.on("error", reject)
    message.on("end", () => {
      const headers = new Headers()
      for (const [key, value] of Object.entries(message.headers)) {
        if (value === undefined) continue
        for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item)
      }
      const status = message.statusCode ?? 502
      const body = status === 204 || status === 304 ? null : Buffer.concat(chunks)
      const response = new Response(body, { status, statusText: message.statusMessage ?? "", headers })
      Object.defineProperty(response, "url", { value: url })
      resolve(response)
    })
  })
}

function abortError(): Error {
  const error = new Error("The operation was aborted.")
  error.name = "AbortError"
  return error
}

async function viaProxy(target: URL, proxy: URL, init: RequestInit | undefined): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase()
  const headers = { ...headerRecord(init), host: target.host }
  const body = typeof init?.body === "string" ? init.body : init?.body == null ? null : String(init.body)
  const signal = init?.signal ?? undefined
  if (signal?.aborted) throw abortError()
  const proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80))
  const proxyRequest = proxy.protocol === "https:" ? httpsRequest : httpRequest

  if (target.protocol === "http:") {
    // A plain-http target: the absolute URL goes to the proxy as the request target.
    return new Promise((resolve, reject) => {
      const req = proxyRequest({ host: proxy.hostname, port: proxyPort, method, path: target.href, headers: { ...headers, ...proxyAuth(proxy) }, signal, agent: false })
      req.on("response", (message) => resolve(toResponse(message, target.href)))
      req.on("error", reject)
      if (body !== null) req.write(body)
      req.end()
    })
  }

  // An https target: CONNECT, then TLS to the target over the tunnel.
  const targetPort = Number(target.port || 443)
  const socket = await new Promise<import("node:net").Socket>((resolve, reject) => {
    const req = proxyRequest({
      host: proxy.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: `${target.hostname}:${targetPort}`,
      headers: { host: `${target.hostname}:${targetPort}`, ...proxyAuth(proxy) },
      signal,
      agent: false
    })
    req.on("connect", (response: IncomingMessage, tunnel: import("node:net").Socket) => {
      if (response.statusCode !== 200) {
        tunnel.destroy()
        reject(new Error(`the proxy refused the tunnel to ${target.hostname} (HTTP ${response.statusCode ?? 0})`))
        return
      }
      resolve(tunnel)
    })
    req.on("error", reject)
    req.end()
  })
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket, servername: target.hostname })
    const req = httpsRequest({
      host: target.hostname,
      port: targetPort,
      method,
      path: `${target.pathname}${target.search}`,
      headers,
      signal,
      agent: false,
      createConnection: () => tls
    })
    req.on("response", (message) => resolve(toResponse(message, target.href)))
    req.on("error", reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

/** A `fetch` for the live checks that goes through the environment's proxy when one is set. */
export function envProxyFetch(env: Env, base: LiveFetch = globalThis.fetch): LiveFetch {
  const fetchWithProxy = async (input: Parameters<LiveFetch>[0], init?: Parameters<LiveFetch>[1]): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const proxy = proxyFor(url, env)
    return proxy ? viaProxy(url, proxy, init) : base(input, init)
  }
  return fetchWithProxy as LiveFetch
}
