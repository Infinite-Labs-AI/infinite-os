// The server-lane ENV step: the middleware reads INFINITE_SITE_SOURCE_KEY + INFINITE_SERVER_EVENT_SECRET
// from the production deployment and silently records nothing without them. A merged install with no
// env vars looked "installed" for twelve days while Infinite received zero events. This step makes
// the variables land, in the founder's preferred order:
//
//   0. Already proven — Infinite's status says the lane is RECEIVING: a server-lane event arrived
//      at/after the CURRENT secret was set (pixel traffic never counts). Nothing to set.
//   B. Infinite writes them — the workspace has a Vercel hosting connection with env-write scope:
//      the desktop's bridge asks the cloud to push the EXISTING secret straight into Vercel
//      (production) and redeploy. The secret never reaches this process.
//   C. The founder's own vercel CLI — the repo is linked locally (`.vercel/project.json`) and `vercel`
//      is installed: after an explicit interactive yes, write the PUBLIC key first, then mint the
//      secret through the bridge and write it at once. Values go on STDIN (never argv, never a file,
//      never printed). Minting over a secret that has received server-lane events since it was set is
//      refused unless the founder explicitly accepts that it breaks that install.
//   A. Manual — print both names, the public key, where the secret lives, and "production, then
//      redeploy". Always available.
//
// "Working" is never decided here from install state: the verify step waits for a server-seen
// receipt (waitForFirstServerLaneEvent) before the lane may read as verified.
//
// Everything talks to the RUNNING DESKTOP's loopback bridge (bridge.json url + LOCAL bearer), which
// acts on the app's ACTIVE workspace with its own session. This open-core module holds no cloud
// credential and no cloud logic; an app too old to carry these routes answers 404, which is a typed
// "update the Infinite app" refusal, never a crash.
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { serverLaneCopy } from "../server-lane/copy.js"
import { SERVER_LANE_SECRET_ENV, SERVER_LANE_SOURCE_KEY_ENV } from "../server-lane/helpers.js"
import { SINCE_SKEW_MS } from "../server-lane/verify.js"

import type { ServerLaneEnvReport } from "./types.js"
import {
  RATE_LIMITED_REASON,
  SUBSCRIPTION_REQUIRED_REASON,
  desktopNotReadyReason,
  errorCodeOf,
  errorReasonOf,
  errorText,
  isRecord,
  readPayload,
  stripTrailingSlashes
} from "./verify.js"

export const SERVER_LANE_ENV_NAMES = {
  sourceKey: SERVER_LANE_SOURCE_KEY_ENV,
  secret: SERVER_LANE_SECRET_ENV
} as const

/** How long to wait for the first event after Infinite started a redeploy (a build takes minutes). */
export const SERVER_LANE_FIRST_EVENT_BUDGET_MS = 180_000

// ---------------------------------------------------------------------------------------------
// The bridge contract (1bu-1 desktop loopback bridge, acting on the ACTIVE workspace)
// ---------------------------------------------------------------------------------------------

export type ServerLaneLaneState = "no_secret" | "awaiting_first_event" | "receiving"

export interface ServerLaneHostingStatus {
  connected: boolean
  provider: "vercel" | null
  connectionId: string | null
  projectName: string | null
  productionHost: string | null
  envWriteGranted: boolean
  /** The cloud could not read the connection (`multiple_hosting_connections`, `provider_unavailable`, …).
   *  Not a permission answer: `envWriteGranted` is meaningless while this is set. */
  error: string | null
}

/** `GET /v1/analytics/server-lane` — no secret in it, by contract. */
export interface ServerLaneStatus {
  sourceId: string | null
  publicKey: string
  secretSetAt: string | null
  firstProductionReceivedAt: string | null
  serverLaneFirstReceivedAt: string | null
  /** Server-lane receipts only (never the pixel). The one timestamp that may back "receiving". */
  serverLaneLastReceivedAt: string | null
  lastProductionReceivedAt: string | null
  /** `receiving` = a server-lane event arrived at/after the CURRENT `secretSetAt`. */
  laneState: ServerLaneLaneState
  hosting: ServerLaneHostingStatus
}

export type ServerLaneProvisionRedeploy =
  | { deploymentId: string }
  | { skipped: true; reason: string }
  | { unconfirmed: true; reason: string }
  /** A shape this CLI does not know. Reported as unknown — no reason is invented for it. */
  | { unknown: true }

/** `POST /v1/analytics/server-lane/provision-env`. */
export interface ServerLaneProvisionResult {
  written: string[]
  mintedNewSecret: boolean
  redeploy: ServerLaneProvisionRedeploy
}

/** `POST /v1/analytics/server-lane/mint` — carries the secret ONCE. Never logged, never stored. */
export interface ServerLaneMintResult {
  publicKey: string
  secret: string
  secretSetAt: string | null
}

export interface ServerLaneBridgeRefusal {
  ok: false
  /** Contract codes (`no_site_source`, `no_hosting_connection`, `missing_scope`, `env_write_unknown`,
   *  `secret_in_use`, `analytics_secret_env_plain`, `demo_workspace_protected`, `not_linked`,
   *  `unauthorized`), the bridge ladder (`not_ready`, `signed_out`, `no_linked_workspace`,
   *  `cloud_unavailable`, `bridge_credentials_rejected`, `desktop_update_required`, …), or transport. */
  code: string
  message: string
  httpStatus: number | null
}

export type ServerLaneBridgeAnswer<T> = { ok: true; value: T } | ServerLaneBridgeRefusal

export interface ServerLaneBridge {
  status(): Promise<ServerLaneBridgeAnswer<ServerLaneStatus>>
  provisionEnv(body: { hostingConnectionId?: string }): Promise<ServerLaneBridgeAnswer<ServerLaneProvisionResult>>
  mint(body: { confirmReplaceLive?: boolean }): Promise<ServerLaneBridgeAnswer<ServerLaneMintResult>>
}

export const SERVER_LANE_UPDATE_REQUIRED_REASON = serverLaneCopy.envStep.updateRequired

/** Cloud codes the bridge forwards verbatim; the cloud's own `message` wins when it sends one. */
const CONTRACT_DEFAULT_MESSAGES: Record<string, string> = {
  no_site_source: "this workspace has no Infinite site source yet — set one up in Infinite → Settings › Sources, then re-run",
  no_hosting_connection: "this workspace has no Vercel hosting connection in Infinite",
  missing_scope: "the Vercel connection does not allow environment variables",
  env_write_unknown: "Vercel did not confirm the write",
  secret_in_use: "the current secret has received server-lane events since it was set",
  secret_changed_concurrently: "another secret change landed at the same moment; nothing was replaced",
  analytics_secret_env_plain: "the Vercel project already stores the secret as a plain variable, which Infinite will not overwrite",
  demo_workspace_protected: "this is a protected demo workspace; Infinite does not change its hosting"
}

/** Cloud session/link codes whose next move is ours to name, whatever the cloud's message says. */
const SESSION_MESSAGES: Record<string, string> = {
  not_linked: "this workspace is not linked to your Infinite account — sign in to the Infinite app with the account that owns it, then re-run",
  unauthorized: "the Infinite app's session has expired — sign in to the Infinite app, then re-run"
}

const BRIDGE_SERVICE_CODES = new Set(["signed_out", "no_linked_workspace", "cloud_unavailable", "service_unavailable", "subscription_required"])

/** One refusal ladder for all three routes. Coded answers are checked BEFORE the status-only rungs:
 *  a 403 `missing_scope` is an answer, a 404 `not_linked` is not an old app, a 401 `unauthorized` is
 *  the cloud session — only a CODELESS 401/403 is this terminal's bridge credentials. */
export function serverLaneBridgeRefusal(status: number, payload: unknown): ServerLaneBridgeRefusal {
  const code = errorCodeOf(payload)
  const reason = errorReasonOf(payload)
  const refuse = (refusalCode: string, message: string): ServerLaneBridgeRefusal => ({ ok: false, code: refusalCode, message, httpStatus: status })
  if (code && code in CONTRACT_DEFAULT_MESSAGES) return refuse(code, reason ?? CONTRACT_DEFAULT_MESSAGES[code]!)
  if (code && code in SESSION_MESSAGES) return refuse(code, SESSION_MESSAGES[code]!)
  if (status === 409 && isRecord(payload) && typeof payload.state === "string" && payload.state) {
    return refuse("not_ready", desktopNotReadyReason(payload.state))
  }
  if (code === "capability_unavailable" || status === 404) return refuse("desktop_update_required", SERVER_LANE_UPDATE_REQUIRED_REASON)
  if (code && BRIDGE_SERVICE_CODES.has(code)) return refuse(code, reason ?? `the Infinite app could not serve this (HTTP ${status})`)
  if (status === 401 || status === 403) {
    return refuse("bridge_credentials_rejected", `the Infinite app rejected this terminal's bridge credentials (HTTP ${status}) — restart the app and re-run`)
  }
  if (status === 402) return refuse("subscription_required", SUBSCRIPTION_REQUIRED_REASON)
  if (status === 429) return refuse("rate_limited", RATE_LIMITED_REASON)
  if (status === 400) {
    return refuse(code ?? "invalid_request", `the Infinite app rejected the request: ${code ?? "invalid_request"}${reason ? ` — ${reason}` : ""}`)
  }
  return refuse(code ?? "unavailable", reason ?? `the Infinite app could not serve the server lane (HTTP ${status})`)
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null
}

export function decodeServerLaneStatus(payload: unknown): ServerLaneStatus | null {
  if (!isRecord(payload)) return null
  const laneState = payload.laneState
  if (laneState !== "no_secret" && laneState !== "awaiting_first_event" && laneState !== "receiving") return null
  const publicKey = text(payload.publicKey)
  if (!publicKey) return null
  const secretSetAt = text(payload.secretSetAt)
  const serverLaneLastReceivedAt = text(payload.serverLaneLastReceivedAt)
  // "receiving" is a claim about a server-lane receipt under the current secret; without both
  // timestamps it cannot be shown or trusted, so the shape is refused rather than papered over.
  if (laneState === "receiving" && (!secretSetAt || !serverLaneLastReceivedAt)) return null
  const hosting = isRecord(payload.hosting) ? payload.hosting : {}
  return {
    sourceId: text(payload.sourceId),
    publicKey,
    secretSetAt,
    firstProductionReceivedAt: text(payload.firstProductionReceivedAt),
    serverLaneFirstReceivedAt: text(payload.serverLaneFirstReceivedAt),
    serverLaneLastReceivedAt,
    lastProductionReceivedAt: text(payload.lastProductionReceivedAt),
    laneState,
    hosting: {
      connected: hosting.connected === true,
      provider: hosting.provider === "vercel" ? "vercel" : null,
      connectionId: text(hosting.connectionId),
      projectName: text(hosting.projectName),
      productionHost: text(hosting.productionHost),
      envWriteGranted: hosting.envWriteGranted === true,
      error: text(hosting.error)
    }
  }
}

function decodeRedeploy(raw: unknown): ServerLaneProvisionRedeploy {
  if (!isRecord(raw)) return { unknown: true }
  const deploymentId = text(raw.deploymentId)
  if (deploymentId) return { deploymentId }
  const reason = text(raw.reason)
  if (raw.unconfirmed === true && reason) return { unconfirmed: true, reason }
  if (raw.skipped === true && reason) return { skipped: true, reason }
  return { unknown: true }
}

function decodeProvision(payload: unknown): ServerLaneProvisionResult | null {
  if (!isRecord(payload) || !Array.isArray(payload.written)) return null
  return {
    written: payload.written.filter((name): name is string => typeof name === "string"),
    mintedNewSecret: payload.mintedNewSecret === true,
    redeploy: decodeRedeploy(payload.redeploy)
  }
}

function decodeMint(payload: unknown): ServerLaneMintResult | null {
  if (!isRecord(payload)) return null
  const publicKey = text(payload.publicKey)
  const secret = text(payload.secret)
  if (!publicKey || !secret) return null
  return { publicKey, secret, secretSetAt: text(payload.secretSetAt) }
}

export interface DesktopServerLaneBridgeOptions {
  /** The running desktop's loopback bridge origin, from `bridge.json` (never a public host). */
  bridgeUrl: string
  /** The descriptor's LOCAL bridge bearer — not a cloud credential. Never logged, never written. */
  token: string
  fetch?: typeof fetch
}

/** The server-lane routes on the running desktop's loopback bridge. Bodies are exactly the contract's. */
export class DesktopServerLaneBridge implements ServerLaneBridge {
  readonly name = "infinite-desktop"
  private readonly options: DesktopServerLaneBridgeOptions

  constructor(options: DesktopServerLaneBridgeOptions) {
    this.options = options
  }

  status(): Promise<ServerLaneBridgeAnswer<ServerLaneStatus>> {
    return this.call("GET", "/v1/analytics/server-lane", undefined, decodeServerLaneStatus)
  }

  provisionEnv(body: { hostingConnectionId?: string }): Promise<ServerLaneBridgeAnswer<ServerLaneProvisionResult>> {
    return this.call("POST", "/v1/analytics/server-lane/provision-env", body, decodeProvision)
  }

  mint(body: { confirmReplaceLive?: boolean }): Promise<ServerLaneBridgeAnswer<ServerLaneMintResult>> {
    return this.call("POST", "/v1/analytics/server-lane/mint", body, decodeMint)
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | undefined,
    decode: (payload: unknown) => T | null
  ): Promise<ServerLaneBridgeAnswer<T>> {
    const fetchImpl = this.options.fetch ?? globalThis.fetch
    let response: Response
    try {
      response = await fetchImpl(`${stripTrailingSlashes(this.options.bridgeUrl)}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      })
    } catch (error) {
      return { ok: false, code: "unreachable", message: `the Infinite app was unreachable (${errorText(error)})`, httpStatus: null }
    }
    const payload = await readPayload(response)
    if (!response.ok) return serverLaneBridgeRefusal(response.status, payload)
    const value = decode(payload)
    return value
      ? { ok: true, value }
      : { ok: false, code: "unexpected_shape", message: "the Infinite app answered with an unexpected shape", httpStatus: response.status }
  }
}

// ---------------------------------------------------------------------------------------------
// The founder's own vercel CLI
// ---------------------------------------------------------------------------------------------

export interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
  /** Spawn failure (ENOENT when the binary is not installed). */
  error?: string
}

/** Runs one command. `input` is written to STDIN and the pipe closed — the only way a value travels. */
export type CommandRunner = (command: string, args: readonly string[], options: { cwd: string; input?: string }) => Promise<CommandResult>

export const defaultCommandRunner: CommandRunner = (command, args, options) =>
  new Promise((resolveResult) => {
    const windows = process.platform === "win32"
    let stdout = ""
    let stderr = ""
    let child: ReturnType<typeof spawn>
    try {
      // Arguments are constants and env var NAMES only (values go on stdin), so the Windows shim is safe.
      child = spawn(windows ? `${command}.cmd` : command, [...args], {
        cwd: options.cwd,
        shell: windows,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }
      })
    } catch (error) {
      resolveResult({ status: null, stdout, stderr, error: errorText(error) })
      return
    }
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("error", (error) => resolveResult({ status: null, stdout, stderr, error: error.message }))
    child.on("close", (code) => resolveResult({ status: code, stdout, stderr }))
    child.stdin?.on("error", () => undefined)
    child.stdin?.end(options.input ?? "")
  })

export type LocalVercelLink =
  | { ok: true; cwd: string; projectName: string | null; version: string | null }
  | { ok: false; reason: "not_linked" | "cli_missing" }

/** `.vercel/project.json` in the app root (else the repo root), and a `vercel` that answers `--version`. */
export async function detectLocalVercel(input: { root: string; appRootAbsolute: string; runner: CommandRunner }): Promise<LocalVercelLink> {
  const cwd = [input.appRootAbsolute, input.root].find((dir) => existsSync(join(dir, ".vercel", "project.json")))
  if (!cwd) return { ok: false, reason: "not_linked" }
  const probe = await input.runner("vercel", ["--version"], { cwd })
  if (probe.status !== 0) return { ok: false, reason: "cli_missing" }
  let projectName: string | null = null
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(cwd, ".vercel", "project.json"), "utf8"))
    projectName = isRecord(parsed) ? text(parsed.projectName) : null
  } catch {
    projectName = null
  }
  const version = /(\d+\.\d+\.\d+)/.exec(`${probe.stdout}\n${probe.stderr}`)?.[1] ?? null
  return { ok: true, cwd, projectName, version }
}

export interface EnvAddCapabilities {
  force: boolean
  sensitive: boolean
  yes: boolean
}

/** Read the INSTALLED CLI's `env add --help` — flags have come and gone across versions; never guess. */
export async function detectEnvAddCapabilities(runner: CommandRunner, cwd: string): Promise<EnvAddCapabilities> {
  const help = await runner("vercel", ["env", "add", "--help"], { cwd })
  const body = `${help.stdout}\n${help.stderr}`
  return {
    force: /(^|\s)--force\b/m.test(body),
    sensitive: /(^|\s)--sensitive\b/m.test(body),
    yes: /(^|\s)--yes\b/m.test(body)
  }
}

const ANSI_PATTERN = /\[[0-9;]*[A-Za-z]/g

/** A secret never survives into printed output, even if a CLI echoes stdin back. */
export function redactSecrets(value: string, secrets: readonly string[]): string {
  let out = value
  for (const secret of secrets) if (secret) out = out.split(secret).join("<redacted>")
  return out
}

function failureDetail(result: CommandResult, secrets: readonly string[]): string {
  if (result.error) return redactSecrets(result.error, secrets)
  const lines = redactSecrets(`${result.stderr}\n${result.stdout}`, secrets)
    .replace(ANSI_PATTERN, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  const line = lines.find((entry) => /error|exist|not |fail|denied|invalid|forbidden/i.test(entry)) ?? lines[0]
  if (!line) return `exit ${result.status ?? "unknown"}`
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

export type VercelVarOutcome = { name: string; ok: true; replaced: boolean } | { name: string; ok: false; detail: string }

/**
 * `vercel env add <NAME> production` with the value on STDIN. When the variable already exists the
 * documented overwrite path is used: `--force` when the installed CLI lists it, otherwise
 * `vercel env rm <NAME> production -y` and add again.
 */
export async function setVercelProductionVar(input: {
  runner: CommandRunner
  cwd: string
  name: string
  value: string
  sensitive: boolean
  capabilities: EnvAddCapabilities
  secrets: readonly string[]
}): Promise<VercelVarOutcome> {
  const { runner, cwd, name, value, capabilities } = input
  const addArgs = (force: boolean): string[] => [
    "env", "add", name, "production",
    ...(force ? ["--force"] : []),
    ...(input.sensitive && capabilities.sensitive ? ["--sensitive"] : []),
    ...(capabilities.yes ? ["--yes"] : [])
  ]
  const first = await runner("vercel", addArgs(capabilities.force), { cwd, input: value })
  if (first.status === 0) return { name, ok: true, replaced: false }
  const detail = failureDetail(first, input.secrets)
  if (!capabilities.force && /already exist|already been added|exists already/i.test(`${first.stderr}\n${first.stdout}`)) {
    const removed = await runner("vercel", ["env", "rm", name, "production", "-y"], { cwd })
    if (removed.status !== 0) return { name, ok: false, detail: failureDetail(removed, input.secrets) }
    const second = await runner("vercel", addArgs(false), { cwd, input: value })
    return second.status === 0 ? { name, ok: true, replaced: true } : { name, ok: false, detail: failureDetail(second, input.secrets) }
  }
  return { name, ok: false, detail }
}

// ---------------------------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------------------------

export interface ServerLaneEnvStepInput {
  mode: "apply" | "verify-only"
  interactive: boolean
  /** `--yes`: approves Infinite's own write (path B). Never approves a mint (path C) or a deploy. */
  yes: boolean
  /** `--replace-live-secret`: the only non-interactive way to mint over a live secret. */
  replaceLiveSecret: boolean
  /** `--redeploy`: run `vercel --prod` after the local path without asking — on a clean, pushed tree only. */
  redeploy: boolean
  /** `--allow-dirty`: with `--redeploy`, deploy even when the tree has uncommitted/unpushed changes. */
  allowDirty: boolean
  root: string
  appRootAbsolute: string
  /** The public site source key this run already knows (artifacts/flags), shown when the bridge cannot say. */
  knownPublicKey?: string
  bridge?: ServerLaneBridge
  runner?: CommandRunner
  say(line: string): void
  confirm(question: string, defaultYes: boolean): Promise<boolean>
}

export interface ServerLaneEnvStepResult {
  report: ServerLaneEnvReport
  /** The status the decision was made on. Null when it could not be read. */
  status: ServerLaneStatus | null
}

type Approval = { ok: true } | { ok: false; note: string }

async function approve(input: ServerLaneEnvStepInput, question: string, yesApproves: boolean): Promise<Approval> {
  const copy = serverLaneCopy.envStep
  if (yesApproves && input.yes) return { ok: true }
  if (!input.interactive) return { ok: false, note: yesApproves ? copy.nonInteractiveNoYes : copy.localNeedsInteractive }
  return (await input.confirm(question, true)) ? { ok: true } : { ok: false, note: copy.declined }
}

export async function runServerLaneEnvStep(input: ServerLaneEnvStepInput): Promise<ServerLaneEnvStepResult> {
  const copy = serverLaneCopy.envStep
  const report: ServerLaneEnvReport = {
    path: "manual",
    envSet: "unknown",
    envNames: { ...SERVER_LANE_ENV_NAMES },
    publicKey: input.knownPublicKey ?? null,
    laneState: null,
    statusRefusal: null,
    hosting: null,
    written: [],
    mintedNewSecret: false,
    redeploy: { state: "not_run" },
    attempts: [],
    firstEvent: { state: "not_checked" }
  }
  let status: ServerLaneStatus | null = null
  const manual = (hint?: string): ServerLaneEnvStepResult => {
    input.say(copy.manualHeading)
    for (const line of copy.manualLines(report.publicKey)) input.say(line)
    if (hint) input.say(hint)
    return { report, status }
  }

  const bridge = input.bridge
  if (!bridge) {
    report.statusRefusal = { code: "no_desktop", message: copy.noDesktop }
    input.say(copy.noDesktop)
    return manual()
  }
  const answer = await bridge.status()
  if (!answer.ok) {
    report.statusRefusal = { code: answer.code, message: answer.message }
    input.say(copy.statusRefused(answer.message))
    return manual()
  }
  status = answer.value
  report.publicKey = status.publicKey
  report.laneState = status.laneState
  report.hosting = {
    connected: status.hosting.connected,
    provider: status.hosting.provider,
    projectName: status.hosting.projectName,
    envWriteGranted: status.hosting.envWriteGranted,
    error: status.hosting.error
  }

  if (status.laneState === "receiving" && status.serverLaneLastReceivedAt) {
    report.path = "already_receiving"
    report.envSet = "yes"
    input.say(copy.receiving(status.serverLaneLastReceivedAt))
    return { report, status }
  }
  if (input.mode === "verify-only") {
    input.say(copy.verifyOnlyNoWrites)
    return manual()
  }

  // PATH B — Infinite writes through its own Vercel connection.
  const hosting = status.hosting
  const vercelConnected = hosting.connected && hosting.provider === "vercel"
  if (hosting.error) {
    // A connection Infinite could not READ is not a permission answer — never say "reconnect".
    report.attempts.push({ path: "infinite_vercel", outcome: "unavailable", code: hosting.error })
    input.say(hosting.error === "multiple_hosting_connections" ? copy.multipleHostingConnections(hosting.productionHost) : copy.hostingReadFailed(hosting.error))
  } else if (vercelConnected && hosting.envWriteGranted) {
    input.say(copy.infiniteWillWrite(hosting.projectName))
    const approval = await approve(input, copy.infiniteConfirm, true)
    if (!approval.ok) {
      report.attempts.push({ path: "infinite_vercel", outcome: "declined", message: approval.note })
      input.say(approval.note)
      return manual()
    }
    const provisioned = await bridge.provisionEnv(hosting.connectionId ? { hostingConnectionId: hosting.connectionId } : {})
    if (provisioned.ok) {
      const result = provisioned.value
      report.path = "infinite_vercel"
      report.written = [...result.written]
      report.mintedNewSecret = result.mintedNewSecret
      const names = [SERVER_LANE_SOURCE_KEY_ENV, SERVER_LANE_SECRET_ENV]
      const missing = names.filter((name) => !result.written.includes(name))
      report.envSet = missing.length === 0 ? "yes" : "unknown"
      report.attempts.push({ path: "infinite_vercel", outcome: "ok" })
      input.say(copy.written(result.written.length > 0 ? result.written : names, hosting.projectName))
      if (missing.length > 0) input.say(copy.partialWrite(missing))
      if (result.mintedNewSecret) input.say(copy.mintedNewSecret)
      const redeploy = result.redeploy
      if ("deploymentId" in redeploy) {
        report.redeploy = { state: "started", deploymentId: redeploy.deploymentId }
        input.say(copy.redeployStarted(redeploy.deploymentId))
      } else if ("unconfirmed" in redeploy) {
        report.redeploy = { state: "unconfirmed", reason: redeploy.reason }
        input.say(copy.redeployUnconfirmed(redeploy.reason))
      } else if ("skipped" in redeploy) {
        report.redeploy = { state: "skipped", reason: redeploy.reason }
        input.say(copy.redeploySkipped(redeploy.reason))
      } else {
        report.redeploy = { state: "unknown" }
        input.say(copy.redeployUnknown)
      }
      return { report, status }
    }
    report.attempts.push({ path: "infinite_vercel", outcome: "refused", code: provisioned.code, message: provisioned.message })
    if (provisioned.code === "env_write_unknown") {
      // Unknown is not "failed": a local mint now could rotate a secret Vercel may already hold.
      input.say(copy.envWriteUnknown(provisioned.message))
      return manual()
    }
    if (provisioned.code === "missing_scope") input.say(copy.reconnectVercel)
    else if (provisioned.code === "no_hosting_connection") input.say(copy.noHostingConnection)
    else {
      input.say(copy.providerRefused(provisioned.message))
      return manual()
    }
  } else if (vercelConnected) {
    report.attempts.push({ path: "infinite_vercel", outcome: "refused", code: "missing_scope", message: copy.reconnectVercel })
    input.say(copy.reconnectVercel)
  }

  // PATH C — the founder's own linked vercel CLI.
  const local = await setWithLocalVercel(input, bridge, status, report)
  if (local === "done") return { report, status }
  return manual(vercelConnected || hosting.error ? undefined : copy.connectHostingHint)
}

/**
 * Order is load-bearing: probe the CLI and write the PUBLIC key first, so an unauthenticated CLI, a
 * wrong team or a missing flag fails while nothing has been minted. Only then mint, and write the
 * secret immediately. A failure after the mint says plainly that a new secret is active and unset.
 */
async function setWithLocalVercel(
  input: ServerLaneEnvStepInput,
  bridge: ServerLaneBridge,
  status: ServerLaneStatus,
  report: ServerLaneEnvReport
): Promise<"done" | "manual"> {
  const copy = serverLaneCopy.envStep
  const runner = input.runner ?? defaultCommandRunner
  const link = await detectLocalVercel({ root: input.root, appRootAbsolute: input.appRootAbsolute, runner })
  if (!link.ok) {
    report.attempts.push({ path: "local_vercel", outcome: "unavailable", code: link.reason })
    return "manual"
  }
  for (const line of copy.localExplain(link.projectName, status.secretSetAt)) input.say(line)
  const approval = await approve(input, copy.localConfirm, false)
  if (!approval.ok) {
    report.attempts.push({ path: "local_vercel", outcome: "declined", message: approval.note })
    input.say(approval.note)
    return "manual"
  }

  const capabilities = await detectEnvAddCapabilities(runner, link.cwd)
  const writeSourceKey = async (publicKey: string): Promise<boolean> => {
    const outcome = await setVercelProductionVar({ runner, cwd: link.cwd, name: SERVER_LANE_SOURCE_KEY_ENV, value: publicKey, sensitive: false, capabilities, secrets: [] })
    if (!outcome.ok) {
      input.say(copy.localVarFailed(SERVER_LANE_SOURCE_KEY_ENV, outcome.detail))
      report.attempts.push({ path: "local_vercel", outcome: "failed", code: "vercel_env_add_failed", message: `${SERVER_LANE_SOURCE_KEY_ENV}: ${outcome.detail}` })
      return false
    }
    if (!report.written.includes(SERVER_LANE_SOURCE_KEY_ENV)) report.written.push(SERVER_LANE_SOURCE_KEY_ENV)
    input.say(copy.localVarSet(SERVER_LANE_SOURCE_KEY_ENV, outcome.replaced))
    return true
  }

  // 1. The public key — nothing minted yet, so a failure here changes nothing about the secret.
  if (!(await writeSourceKey(status.publicKey))) {
    input.say(copy.sourceKeyFailedNothingMinted)
    return "manual"
  }

  // 2. Mint, guarded: `secret_in_use` = a secret exists AND the server lane received since it was set.
  let minted = await bridge.mint({})
  if (!minted.ok && minted.code === "secret_in_use") {
    input.say(copy.liveSecretWarning(status.secretSetAt))
    let replace = false
    if (input.replaceLiveSecret) replace = true
    else if (input.interactive) replace = await input.confirm(copy.liveSecretConfirm, false)
    else input.say(copy.liveSecretNonInteractive)
    if (!replace) {
      report.attempts.push({ path: "local_vercel", outcome: "refused", code: "secret_in_use", message: minted.message })
      if (input.interactive && !input.replaceLiveSecret) input.say(copy.liveSecretKept)
      return "manual"
    }
    minted = await bridge.mint({ confirmReplaceLive: true })
  }
  if (!minted.ok) {
    report.attempts.push({ path: "local_vercel", outcome: "refused", code: minted.code, message: minted.message })
    // Never retried: a retry could replace a secret someone else just set. Nothing was minted, so the
    // public key already written is still correct.
    input.say(minted.code === "secret_changed_concurrently" ? copy.mintChangedConcurrently : copy.mintRefused(minted.message))
    return "manual"
  }

  const { publicKey, secret } = minted.value
  report.mintedNewSecret = true
  report.publicKey = publicKey
  const secrets = [secret]
  const secretActiveNotSet = (): "manual" => {
    report.envSet = "no"
    for (const line of copy.secretActiveNotSet) input.say(line)
    return "manual"
  }

  // 3. The secret, immediately. (A source that changed mid-run gets its new public key first.)
  if (publicKey !== status.publicKey) {
    input.say(copy.sourceChanged(publicKey))
    if (!(await writeSourceKey(publicKey))) return secretActiveNotSet()
  }
  const secretWrite = await setVercelProductionVar({ runner, cwd: link.cwd, name: SERVER_LANE_SECRET_ENV, value: secret, sensitive: true, capabilities, secrets })
  if (!secretWrite.ok) {
    input.say(copy.localVarFailed(SERVER_LANE_SECRET_ENV, secretWrite.detail))
    report.attempts.push({ path: "local_vercel", outcome: "failed", code: "vercel_env_add_failed", message: `${SERVER_LANE_SECRET_ENV}: ${secretWrite.detail}` })
    return secretActiveNotSet()
  }
  report.written.push(SERVER_LANE_SECRET_ENV)
  input.say(copy.localVarSet(SERVER_LANE_SECRET_ENV, secretWrite.replaced))
  report.path = "local_vercel"
  report.envSet = "yes"
  report.attempts.push({ path: "local_vercel", outcome: "ok" })

  await redeployWithLocalVercel({
    runner,
    cwd: link.cwd,
    interactive: input.interactive,
    redeploy: input.redeploy,
    allowDirty: input.allowDirty,
    secrets,
    say: input.say,
    confirm: input.confirm
  }, report)
  return "done"
}

export type DeployTreeCheck =
  | { state: "clean" }
  | { state: "unsafe"; reason: "dirty_working_tree" | "unpushed_commits" | "git_state_unknown"; ahead?: number }

/** The harness's own outputs (the same exclusion as its clean-tree gate) never make a deploy "dirty". */
function isHarnessOwnPath(path: string): boolean {
  return path.startsWith(".infinite/") || path === ".infinite" || path === ".gitignore"
}

/**
 * `vercel --prod` uploads the LOCAL tree, so what it would ship is decided here: uncommitted changes,
 * commits not pushed to an existing upstream, or a git state that cannot be read (not a repo) are all
 * unsafe. No upstream at all is not a finding — there is nothing to compare against.
 */
export async function inspectDeployTree(runner: CommandRunner, cwd: string): Promise<DeployTreeCheck> {
  const status = await runner("git", ["status", "--porcelain"], { cwd })
  if (status.status !== 0) return { state: "unsafe", reason: "git_state_unknown" }
  const foreign = status.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""))
    .filter((path) => !isHarnessOwnPath(path))
  if (foreign.length > 0) return { state: "unsafe", reason: "dirty_working_tree" }
  const upstream = await runner("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd })
  if (upstream.status !== 0) return { state: "clean" }
  const ahead = await runner("git", ["rev-list", "--count", "@{upstream}..HEAD"], { cwd })
  const count = /^\d+$/.test(ahead.stdout.trim()) ? Number.parseInt(ahead.stdout.trim(), 10) : Number.NaN
  if (ahead.status !== 0 || !Number.isFinite(count)) return { state: "unsafe", reason: "git_state_unknown" }
  return count > 0 ? { state: "unsafe", reason: "unpushed_commits", ahead: count } : { state: "clean" }
}

/**
 * The local redeploy decision. Clean tree: `--redeploy` deploys, otherwise an interactive [y/N].
 * Unsafe tree: `--redeploy --allow-dirty` deploys with a warning; interactive runs get a prompt that
 * names what would ship (default No, even with `--redeploy`); non-interactive runs refuse.
 */
export async function redeployWithLocalVercel(
  input: {
    runner: CommandRunner
    cwd: string
    interactive: boolean
    redeploy: boolean
    allowDirty: boolean
    secrets: readonly string[]
    say(line: string): void
    confirm(question: string, defaultYes: boolean): Promise<boolean>
  },
  report: ServerLaneEnvReport
): Promise<void> {
  const copy = serverLaneCopy.envStep
  if (!input.redeploy && !input.interactive) {
    report.redeploy = { state: "skipped", reason: "not run without --redeploy" }
    input.say(copy.redeployNeeded)
    return
  }
  const tree = await inspectDeployTree(input.runner, input.cwd)
  if (tree.state === "unsafe") {
    const why = copy.redeployTreeUnsafe(tree.reason, tree.ahead ?? 0)
    if (input.redeploy && input.allowDirty) {
      input.say(copy.redeployAllowDirty(why))
    } else if (input.interactive) {
      if (!(await input.confirm(copy.redeployUnsafeConfirm(why), false))) {
        report.redeploy = { state: "skipped", reason: tree.reason }
        input.say(copy.redeployNeeded)
        return
      }
    } else {
      report.redeploy = { state: "skipped", reason: tree.reason }
      input.say(copy.redeployRefusedUnsafe(why))
      input.say(copy.redeployNeeded)
      return
    }
  } else if (!input.redeploy && !(await input.confirm(copy.redeployConfirm, false))) {
    report.redeploy = { state: "skipped", reason: "declined" }
    input.say(copy.redeployNeeded)
    return
  }
  const result = await input.runner("vercel", ["--prod"], { cwd: input.cwd })
  if (result.status === 0) {
    const urls = `${result.stdout}`.match(/https:\/\/[^\s"'<>]+/g)
    const url = urls ? urls[urls.length - 1]! : null
    report.redeploy = { state: "deployed", url }
    input.say(copy.redeployRan(url))
  } else {
    const detail = failureDetail(result, input.secrets)
    report.redeploy = { state: "failed", detail }
    input.say(copy.redeployFailed(detail))
    input.say(copy.redeployNeeded)
  }
}

// ---------------------------------------------------------------------------------------------
// The first server-seen event
// ---------------------------------------------------------------------------------------------

export type FirstEventWait = { state: "received"; at: string } | { state: "waiting" } | { state: "refused"; message: string }

const TRANSIENT_CODES = new Set(["rate_limited", "unavailable", "cloud_unavailable", "service_unavailable", "unreachable"])

/**
 * A receipt for THIS run is a status that is `receiving` AND whose `serverLaneLastReceivedAt` (server
 * lane only, never pixel) is both newer than the run start and at/after the current `secretSetAt`.
 * "Ever received" never counts: a lane that received last month under a since-rotated secret is dead.
 * The run start is widened by SINCE_SKEW_MS, the same clock-skew allowance the verify backends use.
 */
export function isFreshServerLaneReceipt(status: ServerLaneStatus, runStartedAtMs: number): string | null {
  const last = status.serverLaneLastReceivedAt
  if (status.laneState !== "receiving" || !last || !status.secretSetAt) return null
  const lastMs = Date.parse(last)
  const secretMs = Date.parse(status.secretSetAt)
  if (!Number.isFinite(lastMs) || !Number.isFinite(secretMs)) return null
  if (lastMs < secretMs) return null
  if (lastMs <= runStartedAtMs - SINCE_SKEW_MS) return null
  return last
}

/** Poll the status until a fresh server-lane receipt appears. Same budget/interval idiom as verify. */
export async function waitForFirstServerLaneEvent(input: {
  bridge: ServerLaneBridge
  /** ISO start of this run (the report's `startedAt`). */
  runStartedAt: string
  now: () => number
  sleep: (ms: number) => Promise<void>
  budgetMs: number
  pollIntervalMs: number
}): Promise<FirstEventWait> {
  const runStartedAtMs = Date.parse(input.runStartedAt)
  if (!Number.isFinite(runStartedAtMs)) throw new Error(`waitForFirstServerLaneEvent: invalid runStartedAt ${input.runStartedAt}`)
  const startedAt = input.now()
  let transientStreak = 0
  for (;;) {
    const answer = await input.bridge.status()
    if (answer.ok) {
      transientStreak = 0
      const at = isFreshServerLaneReceipt(answer.value, runStartedAtMs)
      if (at) return { state: "received", at }
    } else if (!TRANSIENT_CODES.has(answer.code) || ++transientStreak >= 3) {
      return { state: "refused", message: answer.message }
    }
    if (input.now() - startedAt + input.pollIntervalMs > input.budgetMs) return { state: "waiting" }
    await input.sleep(input.pollIntervalMs)
  }
}
