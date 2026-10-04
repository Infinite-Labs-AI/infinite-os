/* global process, URL, Response, setTimeout */
// Preloaded into the BUILT wizard by the offline E2E (`node --import <this> dist/src/cli.js --json`;
// test-only, never published). It does two things, both through seams the real wiring already has:
//
// 1. The live-site checks (T1: byte census, redirect walk, CSP, Meta domains, and `prove`'s reads) get a
//    fixture production site instead of the internet: `createDefaultWizardWiring({ fetch })` is the
//    published wiring with its documented `DefaultDepsOverrides.fetch` test seam, installed BEFORE the CLI
//    runs (`installDefaultWizardWiring` keeps a wiring that is already set). The routes come from the JSON
//    file named by E2E_LIVE_SITE (`{"<https URL>": {status, headers, body}}`); a path the fixture lacks on a
//    fixture host is a 404, and any other host is a network error, never a request.
// 2. Node's global `fetch` (which ignores HTTP(S)_PROXY, so the refusing proxy could not see it) is fenced:
//    loopback (the fake bridge) passes; anything else is refused and recorded, so "nothing reached any
//    network" holds for that path too.
//
// Every live read and every refused attempt is appended to E2E_LIVE_RECORD.
import { appendFileSync, readFileSync } from "node:fs"

const record = (entry) => {
  if (process.env.E2E_LIVE_RECORD) appendFileSync(process.env.E2E_LIVE_RECORD, `${JSON.stringify(entry)}\n`)
}
const urlOf = (input) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])

const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = new URL(urlOf(input))
  if (LOOPBACK.has(url.hostname)) return realFetch(input, init)
  record({ kind: "refused", via: "global_fetch", url: url.href })
  throw new TypeError(`fetch failed (offline E2E: ${url.host} is not reachable)`)
}

const routes = process.env.E2E_LIVE_SITE ? JSON.parse(readFileSync(process.env.E2E_LIVE_SITE, "utf8")) : {}
const fixtureHosts = new Set(Object.keys(routes).map((href) => new URL(href).host))

const liveFetch = async (input, init) => {
  const href = urlOf(input)
  const url = new URL(href)
  const method = (init?.method ?? "GET").toUpperCase()
  if (!fixtureHosts.has(url.host)) {
    record({ kind: "refused", via: "live_checks", method, url: href })
    throw new TypeError(`fetch failed (offline E2E: ${url.host} is not the fixture site)`)
  }
  const route = routes[`${url.origin}${url.pathname}`] ?? { status: 404, headers: { "content-type": "text/html" }, body: "<!doctype html><title>Not found</title>" }
  record({ kind: "live", method, url: href, status: route.status })
  const body = method === "HEAD" || route.status === 204 || route.status === 304 ? null : (route.body ?? "")
  const response = new Response(body, { status: route.status, headers: route.headers ?? {} })
  Object.defineProperty(response, "url", { value: href })
  return response
}

const { setWizardWiring } = await import(new URL("../../dist/src/wizard/wiring.js", import.meta.url).href)
const { createDefaultWizardWiring } = await import(new URL("../../dist/src/wizard/deps.js", import.meta.url).href)
const wiring = createDefaultWizardWiring({ fetch: liveFetch })

// §4.3 (c): the agent resolver injected EMPTY (not a trimmed PATH: the fake agents are still on it).
if (process.env.E2E_NO_AGENTS === "1") {
  const createDeps = wiring.createDeps
  wiring.createDeps = async (input) => {
    const deps = await createDeps(input)
    deps.agents.detect = async () => ({ worker: null, reviewer: null, nested: null, unavailable: [] })
    return deps
  }
}

// §3y (IO-12): a run that must WAIT minutes by design (the 3-minute proof grace after a deploy) runs on virtual
// time: the clock's sleep advances an offset and yields briefly, and `now()` includes the offset, so every
// deadline the wizard computes from its clock still holds — in seconds of real time. E2E_FAST_CLOCK=1 only.
if (process.env.E2E_FAST_CLOCK === "1") {
  const createDeps = wiring.createDeps
  wiring.createDeps = async (input) => {
    const deps = await createDeps(input)
    let offset = 0
    deps.clock = {
      now: () => new Date(Date.now() + offset),
      sleep: (ms, signal) =>
        new Promise((resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"))
          offset += ms
          setTimeout(resolve, Math.min(ms, 25))
        })
    }
    return deps
  }
}

// §4.3 (e): the user answering the wizard's OWN /dev/tty prompt in nested mode (the test runs with no
// controlling terminal, so the real prompt cannot open). E2E_TTY_ANSWERS names a JSON file:
// {"lines": {"<line kind>": {"approved": bool, "edit"?: string}}, "default": bool}.
if (process.env.E2E_TTY_ANSWERS) {
  const answers = JSON.parse(readFileSync(process.env.E2E_TTY_ANSWERS, "utf8"))
  wiring.ttyPrompter = () => ({
    planLine: async (line) => {
      record({ kind: "tty", line: line.id })
      return answers.lines?.[line.kind] ?? { approved: answers.default === true }
    },
    ask: async () => "__timeout__",
    close: () => {}
  })
}

setWizardWiring(wiring)
