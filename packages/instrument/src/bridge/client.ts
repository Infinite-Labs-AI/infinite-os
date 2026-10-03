// `TagBridgeClient` (§3a): one typed method per bridge verb, over loopback HTTP/1.1 JSON, with strict
// request AND response decoding and one error type (`BridgeError`).
//
// Rules this client enforces (the desktop enforces them too; both sides refuse):
// - only `http://127.0.0.1:<port>` from a validated descriptor; no `Origin` header is ever sent, and the
//   `Host` header is exactly `127.0.0.1:<port>` (node:http sets it from the URL);
// - `Authorization: Bearer <token>`, `X-Infinite-Tag-Version` on every call, `X-Infinite-Link-Id` on every
//   link-scoped call (a link-scoped call before the link exists is a programming error and throws);
// - a verb whose capability the descriptor does not advertise is never called (`capability_missing`), and a
//   request body is checked against the verb's exact shape before it is sent (a new field never reaches an
//   old verb);
// - bodies ≤ 64 KB; 35 s per call; long polls ask for ≤ 25 s;
// - a success response must have exactly the verb's keys (unknown or missing → `bad_response`), protocol 1,
//   and echo the request id the client sent (POST/PATCH: the body's `requestId`; GET: the `X-Request-Id`
//   header every GET carries, §3z.2 A7); an error response maps to `BridgeError {status, code,
//   retryable}` when it is a well-formed §3a.2 envelope with a known code, else to `generic`.
// The token is held in memory only and never appears in an error message.
import { randomUUID } from "node:crypto"
import { request as httpRequest } from "node:http"

import {
  BRIDGE_ERROR_RESPONSE_SHAPE,
  BRIDGE_HEADERS,
  BRIDGE_ID_PATTERNS,
  BRIDGE_LIMITS,
  BRIDGE_PATH_PARAM_PATTERNS,
  BRIDGE_VERBS,
  type BaselineResponse,
  type BridgeCallOptions,
  type BridgeDescriptor,
  type BridgeVerbId,
  type BridgeVerbSpec,
  type ConversionsBody,
  type ConversionsResponse,
  type DeployStatusResponse,
  type DisableSiteSourceResponse,
  type Ga4KeyEventsBody,
  type Ga4KeyEventsResponse,
  type HostingResponse,
  type KeysResponse,
  type LinkPollResponse,
  type LinkRequestBody,
  type LinkRequestResponse,
  type LinkRevokeResponse,
  type MetaRelayEnableBody,
  type MetaRelayStatusResponse,
  type ProofClaimResponse,
  type ProofProducer,
  type ProvisionEnvBody,
  type ProvisionEnvResponse,
  type ReceiptsResponse,
  type RemoveEnvResponse,
  type ReportPostResponse,
  type RunPatch,
  type RunResponse,
  type ServerLaneStatusResponse,
  type SiteSourceBody,
  type SiteSourceResponse,
  type StartRunBody,
  type StartRunResponse,
  type StatusResponse,
  type TagBridgeClient,
  type TagCapability,
  type TestFactsResponse,
  type TestRunCancelResponse,
  type TestRunPollResponse,
  type TestRunStartResponse,
  type WithoutEnvelope
} from "../wizard/contracts/bridge.js"
import type { ReceiptsRequestFields } from "../wizard/contracts/receipts.js"
import type { ReportPhase, ReportV2 } from "../wizard/contracts/report.js"
import { shapeErrors } from "../wizard/contracts/shape.js"
import type { TestRunRequest } from "../wizard/contracts/test-engine.js"
import { readBridgeDescriptor, type DiscoveryOptions } from "./descriptor.js"
import { BridgeError, capabilityMissingError, isBridgeError, isKnownBridgeErrorCode } from "./errors.js"

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

export interface BridgeTransportRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
  timeoutMs: number
  signal?: AbortSignal
}

export interface BridgeTransportResponse {
  status: number
  headers: Record<string, string | undefined>
  body: string
}

export type BridgeTransport = (request: BridgeTransportRequest) => Promise<BridgeTransportResponse>

/** A response body above this is refused (a test result is the largest legitimate body). */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** Plain node:http. No keep-alive pool, no proxy, no `Origin`; `Host` comes from the URL. */
export const nodeHttpTransport: BridgeTransport = (input) =>
  new Promise<BridgeTransportResponse>((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new BridgeError({ status: 0, code: "network_error", message: "The bridge call was cancelled.", retryable: false }))
      return
    }
    const req = httpRequest(input.url, { method: input.method, headers: input.headers, agent: false })
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", onAbort)
      fn()
    }
    const timer = setTimeout(() => {
      finish(() =>
        reject(new BridgeError({ status: 0, code: "timeout", message: "The Infinite app did not answer in time.", retryable: true }))
      )
      req.destroy()
    }, input.timeoutMs)
    const onAbort = () => {
      finish(() => reject(new BridgeError({ status: 0, code: "network_error", message: "The bridge call was cancelled.", retryable: false })))
      req.destroy()
    }
    input.signal?.addEventListener("abort", onAbort, { once: true })
    req.on("error", (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          new BridgeError({
            status: 0,
            code: "network_error",
            message: `Could not reach the Infinite app (${error.code ?? "network error"}).`,
            retryable: true,
            ...(error.code !== undefined ? { errno: error.code } : {})
          })
        )
      )
    })
    req.on("response", (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          finish(() => reject(new BridgeError({ status: res.statusCode ?? 0, code: "bad_response", message: "The bridge answer is too large.", retryable: false })))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      res.on("error", () => {
        finish(() => reject(new BridgeError({ status: 0, code: "network_error", message: "The bridge connection broke.", retryable: true })))
      })
      res.on("end", () => {
        const headers: Record<string, string | undefined> = {}
        for (const [key, value] of Object.entries(res.headers)) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value
        finish(() => resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") }))
      })
    })
    if (input.body !== null) req.write(input.body)
    req.end()
  })

// ---------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------

export interface TagBridgeClientOptions {
  /** `X-Infinite-Tag-Version`. */
  tagVersion: string
  transport?: BridgeTransport
  /** Per call; defaults to 35 s (§3a.2). */
  timeoutMs?: number
  newRequestId?: () => string
  /** The longest a 429's `Retry-After` is waited before the one retry (default RATE_LIMIT_MAX_WAIT_MS). */
  maxRateLimitWaitMs?: number
}

interface CallInput {
  params?: Record<string, string>
  query?: Record<string, string | undefined>
  body?: Record<string, unknown>
  signal?: AbortSignal
}

/** A client bound to one descriptor. */
export class DescriptorTagBridgeClient implements TagBridgeClient {
  private linkId: string | null = null
  private readonly transport: BridgeTransport
  private readonly timeoutMs: number
  private readonly newRequestId: () => string

  constructor(
    private readonly getDescriptor: () => BridgeDescriptor,
    private readonly options: TagBridgeClientOptions,
    private readonly onNetworkError?: (error: BridgeError) => boolean
  ) {
    this.transport = options.transport ?? nodeHttpTransport
    this.timeoutMs = options.timeoutMs ?? BRIDGE_LIMITS.clientTimeoutMs
    this.newRequestId = options.newRequestId ?? randomUUID
  }

  get descriptor(): BridgeDescriptor {
    return this.getDescriptor()
  }

  has(capability: TagCapability): boolean {
    return this.descriptor.capabilities.includes(capability)
  }

  setLinkId(linkId: string | null): void {
    if (linkId !== null && !BRIDGE_ID_PATTERNS.linkId.test(linkId)) throw new Error("setLinkId: not a link id (lk_…)")
    this.linkId = linkId
  }

  /** The link id link-scoped calls carry (null before the link step approves). */
  currentLinkId(): string | null {
    return this.linkId
  }

  status(options?: BridgeCallOptions): Promise<StatusResponse> {
    return this.call("status", { signal: options?.signal })
  }

  requestLink(body: WithoutEnvelope<LinkRequestBody>, options?: BridgeCallOptions): Promise<LinkRequestResponse> {
    return this.call("link.request", { body: { ...body }, signal: options?.signal })
  }

  pollLink(linkRequestId: string, waitSeconds: number, options?: BridgeCallOptions): Promise<LinkPollResponse> {
    return this.call("link.poll", { params: { linkRequestId }, query: { wait: waitParam(waitSeconds) }, signal: options?.signal })
  }

  revokeLink(linkId: string, options?: BridgeCallOptions): Promise<LinkRevokeResponse> {
    return this.call("link.revoke", { body: { linkId }, signal: options?.signal })
  }

  keys(options?: BridgeCallOptions): Promise<KeysResponse> {
    return this.call("keys", { signal: options?.signal })
  }

  hosting(envNames?: readonly string[], options?: BridgeCallOptions): Promise<HostingResponse> {
    const names = envNames && envNames.length > 0 ? envNames.join(",") : undefined
    return this.call("hosting", { query: { envNames: names }, signal: options?.signal })
  }

  deployStatus(sha: string, options?: BridgeCallOptions): Promise<DeployStatusResponse> {
    if (!BRIDGE_ID_PATTERNS.sha40.test(sha)) throw new Error("deployStatus: sha must be 40 lowercase hex")
    return this.call("hosting.deploy", { query: { sha }, signal: options?.signal })
  }

  startRun(body: WithoutEnvelope<StartRunBody>, options?: BridgeCallOptions): Promise<StartRunResponse> {
    return this.call("runs.start", { body: { ...body }, signal: options?.signal })
  }

  claimProof(runId: string, producer: ProofProducer, options?: BridgeCallOptions): Promise<ProofClaimResponse> {
    return this.call("runs.proof-claim", { params: { runId }, body: { producer }, signal: options?.signal })
  }

  patchRun(runId: string, patch: RunPatch, options?: BridgeCallOptions & { producer?: ProofProducer }): Promise<RunResponse> {
    // §3z.8 (A10): the proofState PATCH names its producer, which must hold the claim.
    if (patch.proofState !== undefined && options?.producer === undefined) {
      throw new Error("bridge: a runs.patch with proofState needs a producer (§3z.8)")
    }
    const body: Record<string, unknown> = { patch: { ...patch } }
    if (options?.producer !== undefined) body.producer = options.producer
    return this.call("runs.patch", { params: { runId }, body, signal: options?.signal })
  }

  getRun(runId: string, options?: BridgeCallOptions): Promise<RunResponse> {
    return this.call("runs.get", { params: { runId }, signal: options?.signal })
  }

  postReceipts(runId: string, body: ReceiptsRequestFields, options?: BridgeCallOptions): Promise<ReceiptsResponse> {
    return this.call("receipts", { params: { runId }, body: { ...body }, signal: options?.signal })
  }

  async postReport(runId: string, phase: ReportPhase, report: ReportV2, options?: BridgeCallOptions): Promise<ReportPostResponse> {
    const response = await this.call<ReportPostResponse>("report", {
      params: { runId },
      body: { phase, producer: "tag", partial: false, report },
      signal: options?.signal
    })
    if (response.echo.schema !== report.schema || response.echo.runId !== runId || response.phase !== phase) {
      throw new BridgeError({
        status: BRIDGE_VERBS.report.successStatus,
        code: "bad_response",
        message: "The Infinite app stored a different report than the one sent (echo mismatch).",
        retryable: false,
        verb: "report"
      })
    }
    return response
  }

  baseline(runId: string, options?: BridgeCallOptions & { since?: string }): Promise<BaselineResponse> {
    return this.call("baseline", { query: { runId, since: options?.since }, signal: options?.signal })
  }

  ensureSiteSource(body: WithoutEnvelope<SiteSourceBody>, options?: BridgeCallOptions): Promise<SiteSourceResponse> {
    return this.call("site-source", { body: { ...body }, signal: options?.signal })
  }

  declareConversions(body: WithoutEnvelope<ConversionsBody>, options?: BridgeCallOptions): Promise<ConversionsResponse> {
    return this.call("conversions", { body: { ...body }, signal: options?.signal })
  }

  markGa4KeyEvents(body: WithoutEnvelope<Ga4KeyEventsBody>, options?: BridgeCallOptions): Promise<Ga4KeyEventsResponse> {
    return this.call("ga4-key-events", { body: { ...body }, signal: options?.signal })
  }

  serverLaneStatus(options?: BridgeCallOptions): Promise<ServerLaneStatusResponse> {
    return this.call("server-lane.status", { signal: options?.signal })
  }

  provisionServerLaneEnv(body: WithoutEnvelope<ProvisionEnvBody>, options?: BridgeCallOptions): Promise<ProvisionEnvResponse> {
    return this.call("server-lane.provision-env", { body: { ...body }, signal: options?.signal })
  }

  metaRelayStatus(options?: BridgeCallOptions): Promise<MetaRelayStatusResponse> {
    return this.call("meta-relay.status", { signal: options?.signal })
  }

  enableMetaRelay(body: WithoutEnvelope<MetaRelayEnableBody>, options?: BridgeCallOptions): Promise<MetaRelayStatusResponse> {
    return this.call("meta-relay.enable", { body: { ...body }, signal: options?.signal })
  }

  removeServerLaneEnv(options?: BridgeCallOptions): Promise<RemoveEnvResponse> {
    return this.call("uninstall.remove-env", { body: {}, signal: options?.signal })
  }

  disableSiteSource(options?: BridgeCallOptions): Promise<DisableSiteSourceResponse> {
    return this.call("uninstall.disable-site-source", { body: {}, signal: options?.signal })
  }

  startTest(body: WithoutEnvelope<TestRunRequest>, options?: BridgeCallOptions): Promise<TestRunStartResponse> {
    return this.call("test.start", { body: { ...body }, signal: options?.signal })
  }

  pollTest(testRunId: string, waitSeconds: number, options?: BridgeCallOptions): Promise<TestRunPollResponse> {
    return this.call("test.poll", { params: { testRunId }, query: { wait: waitParam(waitSeconds) }, signal: options?.signal })
  }

  cancelTest(testRunId: string, options?: BridgeCallOptions): Promise<TestRunCancelResponse> {
    return this.call("test.cancel", { params: { testRunId }, body: {}, signal: options?.signal })
  }

  testFacts(runId: string, options?: BridgeCallOptions): Promise<TestFactsResponse> {
    return this.call("test.facts", { query: { runId }, signal: options?.signal })
  }

  // -------------------------------------------------------------------------------------------

  private async call<T>(verb: BridgeVerbId, input: CallInput): Promise<T> {
    try {
      return await this.callOnce<T>(verb, input)
    } catch (error) {
      // §3z.4: a 429 waits ONCE for `Retry-After` (capped), then the error goes on to the outcome table.
      // A 429 is refused before any effect, so even a state-changing verb is safe to send again.
      if (isBridgeError(error) && error.code === "rate_limited" && !input.signal?.aborted) {
        const cap = this.options.maxRateLimitWaitMs ?? RATE_LIMIT_MAX_WAIT_MS
        await waitMs(Math.min(cap, Math.max(0, (error.retryAfterSeconds ?? 1) * 1000)), input.signal)
        return this.callOnce<T>(verb, input)
      }
      // The app restarted (new port + token): re-discover once and retry the same request, but only when a
      // replay cannot double an effect: a read (GET), or a request that never reached the app (connection
      // refused). A POST/PATCH whose connection broke after sending (e.g. a proof claim the cloud may already
      // have granted) is never re-sent; the caller sees the error.
      if (isBridgeError(error) && error.code === "network_error" && error.retryable && safeToReplay(verb, error) && this.onNetworkError?.(error)) {
        return this.callOnce<T>(verb, input)
      }
      throw error
    }
  }

  private async callOnce<T>(verb: BridgeVerbId, input: CallInput): Promise<T> {
    const spec: BridgeVerbSpec = BRIDGE_VERBS[verb]
    const descriptor = this.descriptor
    if (!descriptor.capabilities.includes(spec.capability)) throw capabilityMissingError(spec.capability, verb)
    if (spec.linkScoped && this.linkId === null) {
      throw new Error(`bridge: ${verb} is link-scoped and was called before the link step approved a link`)
    }

    const path = buildPath(spec, input.params ?? {})
    const query = new URLSearchParams()
    for (const key of spec.query) {
      const value = input.query?.[key]
      if (value !== undefined) query.set(key, value)
    }
    for (const key of Object.keys(input.query ?? {})) {
      if (!spec.query.includes(key)) throw new Error(`bridge: ${verb} does not take ?${key}`)
    }
    const qs = query.toString()
    const url = `${descriptor.url}${path}${qs ? `?${qs}` : ""}`

    const headers: Record<string, string> = {
      [BRIDGE_HEADERS.authorization]: `Bearer ${descriptor.token}`,
      [BRIDGE_HEADERS.tagVersion]: this.options.tagVersion,
      Accept: "application/json"
    }
    if (spec.linkScoped && this.linkId) headers[BRIDGE_HEADERS.linkId] = this.linkId

    let body: string | null = null
    let sentRequestId: string | null = null
    if (spec.request) {
      sentRequestId = this.newRequestId()
      const payload = { ...(input.body ?? {}), protocolVersion: 1, requestId: sentRequestId }
      const requestErrors = shapeErrors(payload, spec.request)
      if (requestErrors.length > 0) {
        // Never send a field the verb does not take (an old app would answer 400 unknown_field).
        throw new Error(`bridge: ${verb} request does not match the contract: ${requestErrors[0]}`)
      }
      body = JSON.stringify(payload)
      if (Buffer.byteLength(body, "utf8") > BRIDGE_LIMITS.maxBodyBytes) {
        throw new BridgeError({
          status: 413,
          code: "body_too_large",
          message: `The ${verb} request is larger than 64 KB.`,
          retryable: false,
          verb
        })
      }
      headers[BRIDGE_HEADERS.contentType] = "application/json"
    } else if (input.body !== undefined) {
      throw new Error(`bridge: ${verb} takes no body`)
    } else {
      // §3z.2 (A7): every GET carries a request id in a header; the bridge echoes it.
      sentRequestId = this.newRequestId()
      headers[BRIDGE_HEADERS.requestId] = sentRequestId
    }

    const response = await this.transport({
      method: spec.method,
      url,
      headers,
      body,
      timeoutMs: this.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {})
    })

    if (response.status === spec.successStatus) {
      return decodeSuccess<T>(verb, spec, response, sentRequestId)
    }
    throw decodeError(verb, response)
  }
}

/** The longest a 429's `Retry-After` is honoured before the call fails (§3z.4: one wait). */
export const RATE_LIMIT_MAX_WAIT_MS = 30_000

function waitMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}

function waitParam(waitSeconds: number): string {
  const clamped = Math.max(0, Math.min(BRIDGE_LIMITS.longPollMaxSeconds, Math.floor(waitSeconds)))
  return String(clamped)
}

function buildPath(spec: BridgeVerbSpec, params: Record<string, string>): string {
  return spec.path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment
      const name = segment.slice(1)
      const value = params[name]
      const pattern = (BRIDGE_PATH_PARAM_PATTERNS as Record<string, RegExp>)[name]
      if (value === undefined || !pattern || !pattern.test(value)) {
        throw new Error(`bridge: ${spec.verb} needs a valid :${name}`)
      }
      return encodeURIComponent(value)
    })
    .join("/")
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function decodeSuccess<T>(verb: BridgeVerbId, spec: BridgeVerbSpec, response: BridgeTransportResponse, sentRequestId: string | null): T {
  const bad = (why: string) =>
    new BridgeError({ status: response.status, code: "bad_response", message: `The Infinite app's ${verb} answer was not understood: ${why}`, retryable: false, verb })
  const json = parseJson(response.body)
  if (json === undefined) throw bad("not JSON")
  const errors = shapeErrors(json, spec.response)
  if (errors.length > 0) throw bad(errors[0] ?? "shape")
  const value = json as Record<string, unknown>
  if (value.protocolVersion !== 1) throw bad("protocolVersion is not 1")
  if (typeof value.requestId !== "string") throw bad("requestId is missing")
  if (sentRequestId !== null && value.requestId !== sentRequestId) throw bad("requestId was not echoed")
  return json as T
}

function decodeError(verb: BridgeVerbId, response: BridgeTransportResponse): BridgeError {
  const json = parseJson(response.body)
  const retryAfterRaw = response.headers["retry-after"]
  const retryAfter = retryAfterRaw !== undefined && /^\d+$/.test(retryAfterRaw.trim()) ? Number(retryAfterRaw.trim()) : undefined
  if (json !== undefined && shapeErrors(json, BRIDGE_ERROR_RESPONSE_SHAPE).length === 0) {
    const envelope = json as { requestId: unknown; error: Record<string, unknown> }
    const error = envelope.error
    if (isKnownBridgeErrorCode(error.code) && typeof error.message === "string" && typeof error.retryable === "boolean") {
      return new BridgeError({
        status: response.status,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(typeof error.field === "string" ? { field: error.field } : {}),
        ...(typeof error.state === "string" ? { state: error.state } : {}),
        ...(typeof error.upstreamStatus === "number" ? { upstreamStatus: error.upstreamStatus } : {}),
        ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
        ...(typeof envelope.requestId === "string" ? { requestId: envelope.requestId } : {}),
        verb
      })
    }
  }
  return new BridgeError({
    status: response.status,
    code: "generic",
    message: `The Infinite app answered ${verb} with HTTP ${response.status}.`,
    retryable: response.status >= 500 || response.status === 429,
    ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
    verb
  })
}

/** True when re-sending `verb` after `error` cannot repeat an effect (see `call`). */
export function safeToReplay(verb: BridgeVerbId, error: BridgeError): boolean {
  return BRIDGE_VERBS[verb].method === "GET" || error.errno === "ECONNREFUSED"
}

/** A client bound to a descriptor already read. */
export function createTagBridgeClient(descriptor: BridgeDescriptor, options: TagBridgeClientOptions): DescriptorTagBridgeClient {
  return new DescriptorTagBridgeClient(() => descriptor, options)
}

/**
 * The client the wizard uses: discovery happens on first use (so the `link` step can turn a missing app
 * into its own outcome), and a refused connection re-reads the descriptor once. When the app restarted
 * (a new bootId under the SAME runtime variant) the call is retried against the new port and token; a
 * changed runtime variant is never followed (the link step's RUNTIME_MISMATCH rule).
 */
export function openTagBridge(options: TagBridgeClientOptions & DiscoveryOptions): DescriptorTagBridgeClient {
  let current: BridgeDescriptor | null = null
  const discover = () => readBridgeDescriptor(options)
  return new DescriptorTagBridgeClient(
    () => {
      if (current === null) current = discover()
      return current
    },
    options,
    () => {
      if (current === null) return false
      let next: BridgeDescriptor
      try {
        next = discover()
      } catch {
        return false
      }
      if (next.bootId === current.bootId || next.runtime.variant !== current.runtime.variant) return false
      current = next
      return true
    }
  )
}
