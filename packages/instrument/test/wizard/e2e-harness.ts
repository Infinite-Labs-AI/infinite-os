// The offline end-to-end harness (BUILD-PLAN §4.3, lane I1b; test-only, never published).
//
// It runs the BUILT wizard (`node dist/src/cli.js --json`) as a child process against:
//   - a real git repo made from `fixture-site/` (a Next app-router store with an adopted GA4, a duplicate
//     gtag, an ADOPTED Meta pixel and PostHog, a signup route, login + logout) and a `git init --bare`
//     remote reached through `url.<bare>.insteadOf https://github.com/acme/acme-store.git`;
//   - the fake desktop bridge (in this process; it records every call in order);
//   - the fake `claude`, `codex`, `gh`, `npm` and a `vercel` spy on PATH (`test/wizard/bin`);
//   - a SEALED environment (R1-10): PATH = the fakes + /usr/bin:/bin + node's own dir, no nesting marker,
//     HTTP(S)_PROXY / ALL_PROXY pointing at a listener that refuses and counts every connection, a temp
//     HOME / GROWTH_OS_HOME / TMPDIR;
//   - a fixture production site for the live checks, through the wiring's `fetch` seam (`e2e-preload.mjs`).
// Nothing here talks to a network, a real agent or the user's Infinite session.
import { execFileSync, spawn } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { startFakeBridge, type FakeBridge, type StartFakeBridgeOptions } from "./fake-bridge.js"

const here = dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = resolve(here, "../..")
export const BUILT_CLI = join(PACKAGE_ROOT, "dist/src/cli.js")
export const FAKE_BIN = join(here, "bin")
export const FIXTURE_SITE = join(here, "fixture-site")
export const PRELOAD = join(here, "e2e-preload.mjs")

/** The fixture site's GitHub remote (rewritten to the bare repo by `url.<bare>.insteadOf`). */
export const SITE_REMOTE = "https://github.com/acme/acme-store.git"
export const PRODUCTION_HOST = "acme-store.com"
/** The adopted pixel in the fixture site = the fake keys verb's pixel (16 digits, obviously fake). */
export const FIXTURE_PIXEL_ID = "1234567890123456"
/** A value only the site's runtime `.env` holds; the review scan must redact it wherever it appears. */
export const PLANTED_DOTENV_VALUE = "e2e-planted-dotenv-value-7f3c2a"

/** Every marker that would make the wizard think an agent launched it (§3d.7, §4.3). */
export const NESTING_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION", "AI_AGENT", "CODEX_THREAD_ID", "CODEX_SANDBOX"] as const

function sh(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...env }
  }).trim()
}

export function git(cwd: string, ...args: string[]): string {
  return sh(cwd, args)
}

/** A git command against the bare remote. */
export function bareGit(bare: string, ...args: string[]): string {
  return sh(bare, ["--git-dir", bare, ...args])
}

/** A file's exact bytes at a revision of the bare remote (untrimmed). */
export function bareShow(bare: string, rev: string, path: string): string {
  return execFileSync("git", ["--git-dir", bare, "show", `${rev}:${path}`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: bare, GIT_CONFIG_NOSYSTEM: "1" } })
}

export interface SiteRepo {
  base: string
  repo: string
  bare: string
  home: string
  growthHome: string
  tmp: string
  /** The commit `main` pointed at before the wizard ran. */
  initialSha: string
}

/** A real repo from `fixture-site/`, pushed to a bare remote, plus the run's temp HOME / GROWTH_OS_HOME / TMPDIR. */
export function makeSiteRepo(): SiteRepo {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "infinite-tag-e2e-")))
  const repo = join(base, "site")
  const bare = join(base, "remote.git")
  const home = join(base, "home")
  const growthHome = join(home, ".growth-os")
  const tmp = join(base, "tmp")
  for (const dir of [home, growthHome, tmp]) mkdirSync(dir, { recursive: true })
  cpSync(FIXTURE_SITE, repo, { recursive: true })
  // Tracked dotfiles would apply to infinite-os itself: the fixture keeps `_gitignore`, the repo gets `.gitignore`.
  renameSync(join(repo, "_gitignore"), join(repo, ".gitignore"))
  // The site's runtime secrets: written here, never tracked anywhere (no tracked `.env*`, §0).
  writeFileSync(join(repo, ".env"), `SUPABASE_SERVICE_ROLE=${PLANTED_DOTENV_VALUE}\nNEXT_PUBLIC_SITE_NAME=acme\n`)
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { env: { PATH: "/usr/bin:/bin", HOME: home } })
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "dev@acme-store.example")
  git(repo, "config", "user.name", "Acme Dev")
  git(repo, "config", "commit.gpgsign", "false")
  git(repo, "config", `url.${bare}.insteadOf`, SITE_REMOTE)
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "Acme store")
  git(repo, "remote", "add", "origin", SITE_REMOTE)
  git(repo, "push", "-q", "origin", "main")
  git(repo, "branch", "-q", "-u", "origin/main")
  git(repo, "remote", "set-head", "origin", "main")
  return { base, repo, bare, home, growthHome, tmp, initialSha: git(repo, "rev-parse", "HEAD") }
}

// ---------------------------------------------------------------------------------------------
// The refusing proxy (the "nothing reached any network" mechanism)
// ---------------------------------------------------------------------------------------------

export interface Tripwire {
  port: number
  url: string
  /** The first line each connection sent (e.g. `CONNECT acme-store.com:443 HTTP/1.1`), for the failure message. */
  connections: string[]
  close(): Promise<void>
}

export async function startTripwire(): Promise<Tripwire> {
  const connections: string[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    const index = connections.push("(connected)") - 1
    socket.once("data", (chunk: Buffer) => {
      connections[index] = chunk.toString("utf8").split("\r\n")[0] ?? "(no request line)"
      socket.destroy()
    })
    socket.on("close", () => sockets.delete(socket))
    setTimeout(() => socket.destroy(), 200).unref()
  })
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
  const port = (server.address() as { port: number }).port
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    connections,
    close: () =>
      new Promise<void>((resolveClose) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolveClose())
      })
  }
}

// ---------------------------------------------------------------------------------------------
// The sealed child environment
// ---------------------------------------------------------------------------------------------

export interface SealedEnvInput {
  site: SiteRepo
  bridge: FakeBridge
  tripwire: Tripwire
  ghState: string
  scenario: string
  extra?: Record<string, string>
}

/** The extra PATH entries besides the fakes (asserted to hold no `claude` / `codex`). */
export function extraPathDirs(): string[] {
  return ["/usr/bin", "/bin", dirname(process.execPath)]
}

/** The PATH dirs (besides the fakes) that hold a `claude` or `codex`: must be none (§4.3 sealed env). */
export function realAgentDirs(path: string): string[] {
  return path
    .split(":")
    .filter((dir) => dir !== "" && dir !== FAKE_BIN)
    .filter((dir) => existsSync(dir) && readdirSync(dir).some((name) => name === "claude" || name === "codex"))
}

/** Where `which <tool>` lands in an env (the guard: every agent / gh / npm must be one of the fakes). */
export function whichIn(env: Record<string, string>, tool: string): string {
  return execFileSync("/usr/bin/which", [tool], { env, encoding: "utf8" }).trim()
}

export function sealedEnv(input: SealedEnvInput): Record<string, string> {
  const { site, bridge, tripwire } = input
  // Built from nothing: no variable of the developer's shell (and so no nesting marker, no CODEX_*, no real
  // HOME, no real GROWTH_OS_HOME) reaches the wizard.
  return {
    PATH: [FAKE_BIN, ...extraPathDirs()].join(":"),
    HOME: site.home,
    GROWTH_OS_HOME: bridge.home,
    TMPDIR: site.tmp,
    LANG: "en_US.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    HTTP_PROXY: tripwire.url,
    HTTPS_PROXY: tripwire.url,
    ALL_PROXY: tripwire.url,
    http_proxy: tripwire.url,
    https_proxy: tripwire.url,
    NO_PROXY: "127.0.0.1",
    no_proxy: "127.0.0.1",
    FAKE_GH_STATE: input.ghState,
    FAKE_GH_REMOTE: site.bare,
    FAKE_GH_NODE: process.execPath,
    FAKE_AGENT_SCENARIO: input.scenario,
    FAKE_AGENT_RECORD: join(site.base, "agents.jsonl"),
    FAKE_NPM_RECORD: join(site.base, "npm.jsonl"),
    FAKE_SPY_RECORD: join(site.base, "spy.log"),
    E2E_LIVE_SITE: join(site.base, "live-site.json"),
    E2E_LIVE_RECORD: join(site.base, "live.jsonl"),
    ...(input.extra ?? {})
  }
}

// ---------------------------------------------------------------------------------------------
// The fixture production site (what is live today: the same tags the repo has)
// ---------------------------------------------------------------------------------------------

export const LIVE_HOME_HTML = [
  "<!doctype html><html lang=\"en\"><head><title>Acme Store</title>",
  "<script>window.dataLayer = window.dataLayer || []; function gtag(){dataLayer.push(arguments);} gtag('consent', 'default', { analytics_storage: 'granted' });</script>",
  "<script async src=\"https://www.googletagmanager.com/gtag/js?id=G-FAKE00001\"></script>",
  "<script>window.dataLayer = window.dataLayer || []; function gtag(){dataLayer.push(arguments);} gtag('js', new Date()); gtag('config', 'G-FAKE00001');</script>",
  "<script async src=\"https://www.googletagmanager.com/gtag/js?id=G-FAKE00001\"></script>",
  "<script>gtag('config', 'G-FAKE00001');</script>",
  `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init', '${FIXTURE_PIXEL_ID}');fbq('track', 'PageView');</script>`,
  "<script>!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){}),e.__SV=1}(document,window.posthog||[]);posthog.init('phc_FAKEtestProjectKeyNotReal000',{api_host:'https://us.i.posthog.com'})</script>",
  "</head><body><main><h1>Acme Store</h1><a href=\"/signup\">Start free trial</a><a href=\"/pricing\">Pricing</a></main></body></html>"
].join("\n")

export function writeLiveSite(site: SiteRepo): void {
  const page = { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: LIVE_HOME_HTML }
  const routes: Record<string, unknown> = {}
  for (const host of [PRODUCTION_HOST, `www.${PRODUCTION_HOST}`]) {
    for (const path of ["/", "/pricing", "/signup", "/login"]) routes[`https://${host}${path}`] = page
  }
  writeFileSync(join(site.base, "live-site.json"), JSON.stringify(routes))
}

// ---------------------------------------------------------------------------------------------
// The fake gh state
// ---------------------------------------------------------------------------------------------

export function writeGhState(site: SiteRepo, extra: Record<string, unknown> = {}): string {
  const path = join(site.base, "gh.json")
  writeFileSync(
    path,
    JSON.stringify({
      login: "acme-dev",
      repo: { nameWithOwner: "acme/acme-store", isPrivate: true, defaultBranch: "main", viewerPermission: "ADMIN" },
      // Vercel's preview of ANY head (sha "*"): created by vercel[bot], ready, with its own URL.
      deployments: [
        {
          id: 7001,
          sha: "*",
          environment: "Preview",
          creator: "vercel[bot]",
          statuses: [{ state: "success", environment_url: "https://acme-store-git-infinite-tag-acme.vercel.app" }]
        }
      ],
      ...extra
    })
  )
  return path
}

export function readGhState(path: string): GhState {
  return JSON.parse(readFileSync(path, "utf8")) as GhState
}

export interface GhState {
  login: string
  calls: Array<{ argv: string[]; stdin: string | null }>
  prs: Array<{
    number: number
    url: string
    id: string
    isDraft: boolean
    state: string
    headRefName: string
    baseRefName: string
    title: string
    body: string
    comments: Array<{ author: { login: string }; body: string }>
    reviews: Array<{ id: string; body: string; state: string; commitOID?: string }>
    mergeCommit?: { oid: string } | null
    mergedAt?: string | null
  }>
  threads: Array<{ id: string; prNumber: number; isResolved: boolean; path: string; line: number; comments: Array<{ author: string; body: string }> }>
  [key: string]: unknown
}

/** Merges the PR's branch on the bare remote (as GitHub's merge button would) and marks it merged in gh. */
export function mergePullRequest(site: SiteRepo, ghState: string, number: number): string {
  const state = readGhState(ghState)
  const pr = state.prs.find((candidate) => candidate.number === number)
  if (!pr) throw new Error(`no PR #${number} in the fake gh state`)
  const clone = join(site.base, `merge-${number}`)
  execFileSync("git", ["clone", "-q", site.bare, clone], { env: { PATH: "/usr/bin:/bin", HOME: site.home, GIT_CONFIG_NOSYSTEM: "1" } })
  git(clone, "config", "user.email", "noreply@github.com")
  git(clone, "config", "user.name", "GitHub")
  git(clone, "merge", "-q", "--no-ff", "-m", `Merge pull request #${number} from acme/${pr.headRefName}`, `origin/${pr.headRefName}`)
  git(clone, "push", "-q", "origin", "main")
  const mergeSha = git(clone, "rev-parse", "HEAD")
  Object.assign(pr, { state: "MERGED", isDraft: false, mergeCommit: { oid: mergeSha }, mergedAt: "2026-10-02T10:00:00Z" })
  writeFileSync(ghState, `${JSON.stringify(state, null, 2)}\n`)
  return mergeSha
}

// ---------------------------------------------------------------------------------------------
// Running the built wizard
// ---------------------------------------------------------------------------------------------

export interface WizardEvent {
  v: 1
  t: string
  at: string
  [key: string]: unknown
}

export interface WizardRun {
  code: number
  events: WizardEvent[]
  stderr: string
  /** Every step.done in order. */
  steps(): Array<{ step: string; outcome: string; code?: string; reason?: string }>
  ofType(type: string): WizardEvent[]
}

export type AskResponder = (ask: { askId: string; kind: string; payload: unknown }) => Promise<unknown | undefined> | unknown | undefined

export interface RunOptions {
  cwd: string
  env: Record<string, string>
  args: string[]
  /** Answers an `ask.open` on stdin (undefined = leave it to the answers file / let it close). */
  respond?: AskResponder
  /** Close stdin after this many ms of no open ask (default: keep it open until the run ends). */
  timeoutMs?: number
  /** Extra node flags (default: the live-site preload). */
  nodeFlags?: string[]
}

export function runWizard(options: RunOptions): Promise<WizardRun> {
  if (!existsSync(BUILT_CLI)) throw new Error(`Build the package first (pnpm --filter infinite-tag build): missing ${BUILT_CLI}`)
  const flags = options.nodeFlags ?? ["--import", PRELOAD]
  return new Promise((resolveRun, rejectRun) => {
    // `detached`: a new session with NO controlling terminal, so nothing can ever open the developer's
    // /dev/tty (nested mode's own prompt), and the run is exactly the TTY-less `--json` path.
    const child = spawn(process.execPath, [...flags, BUILT_CLI, ...options.args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: true })
    const events: WizardEvent[] = []
    let buffer = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      rejectRun(new Error(`the wizard did not finish in ${options.timeoutMs ?? 240_000} ms\n${stderr}\n${events.map((event) => JSON.stringify(event)).join("\n").slice(-6000)}`))
    }, options.timeoutMs ?? 240_000)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
        if (!line.trim()) continue
        let event: WizardEvent
        try {
          event = JSON.parse(line) as WizardEvent
        } catch {
          stderr += `[non-JSON stdout] ${line}\n`
          continue
        }
        events.push(event)
        if (event.t === "ask.open" && options.respond) {
          const ask = { askId: String(event.askId), kind: String(event.kind), payload: event.payload }
          void Promise.resolve(options.respond(ask)).then((answer) => {
            if (answer !== undefined && child.stdin.writable) child.stdin.write(`${JSON.stringify({ v: 1, t: "ask.answer", askId: ask.askId, answer })}\n`)
          })
        }
        if (event.t === "run.end") child.stdin.end()
      }
    })
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => (stderr += chunk))
    child.on("error", rejectRun)
    child.on("exit", (code) => {
      clearTimeout(timer)
      resolveRun({
        code: code ?? -1,
        events,
        stderr,
        steps: () =>
          events
            .filter((event) => event.t === "step.done")
            .map((event) => ({
              step: String(event.step),
              outcome: String(event.outcome),
              ...(event.code ? { code: String(event.code) } : {}),
              ...(event.reason ? { reason: String(event.reason) } : {})
            })),
        ofType: (type) => events.filter((event) => event.t === type)
      })
    })
  })
}

/** A compact trace of a run, for failure messages. */
export function trace(run: WizardRun): string {
  const lines = run.events
    .filter((event) => ["step.done", "step.sub", "job.state", "ask.open", "run.end"].includes(event.t))
    .map((event) => {
      if (event.t === "step.sub") return `  ${event.step}: ${event.text}`
      if (event.t === "step.done") return `${event.step} → ${event.outcome}${event.code ? ` ${event.code}` : ""}${event.reason ? ` (${String(event.reason).slice(0, 200)})` : ""}`
      if (event.t === "job.state") return `  job ${event.itemId} = ${event.state} by ${event.by}${event.note ? ` (${String(event.note).slice(0, 160)})` : ""}`
      if (event.t === "ask.open") return `  ask ${event.kind}`
      return `run.end ${JSON.stringify(event)}`
    })
  return `exit ${run.code}\n${lines.join("\n")}\nstderr: ${run.stderr.slice(0, 3000)}`
}

export interface E2eWorld {
  site: SiteRepo
  bridge: FakeBridge
  tripwire: Tripwire
  ghState: string
  scenarioPath: string
  env: Record<string, string>
  close(): Promise<void>
}

/** Everything one E2E scenario needs: the repo, the bridge, the tripwire, gh, the agents' scenario and the env. */
export async function makeWorld(input: { scenario: unknown; bridge?: StartFakeBridgeOptions["script"]; gh?: Record<string, unknown>; env?: Record<string, string> }): Promise<E2eWorld> {
  const site = makeSiteRepo()
  writeLiveSite(site)
  const tripwire = await startTripwire()
  const bridge = await startFakeBridge({ home: site.growthHome, ...(input.bridge ? { script: input.bridge } : {}) })
  const ghState = writeGhState(site, input.gh)
  const scenarioPath = join(site.base, "scenario.json")
  writeFileSync(scenarioPath, JSON.stringify(input.scenario))
  const env = sealedEnv({ site, bridge, tripwire, ghState, scenario: scenarioPath, ...(input.env ? { extra: input.env } : {}) })
  return {
    site,
    bridge,
    tripwire,
    ghState,
    scenarioPath,
    env,
    close: async () => {
      await bridge.close()
      await tripwire.close()
    }
  }
}

export function readJsonl<T = Record<string, unknown>>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

export function listFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : []
}
