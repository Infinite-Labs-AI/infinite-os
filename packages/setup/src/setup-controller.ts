import type { WorkspaceSiteUpsertInput } from "@infinite-os/db";

import type {
  Provisioner,
  ProvisionerContext,
  ProvisionerDetectResult,
  ProvisionerPhaseResult,
  ProvisionerStateSnapshot
} from "./provisioner.js";
import { reconcile } from "./reconciler.js";
import type {
  DetectionState,
  PhaseResult,
  ProviderInventoryRow,
  SetupBrowserHandoffRef,
  ProviderRunState,
  RunOptions,
  SetupInterview,
  SetupProviderId,
  Verb
} from "./types.js";
import { browserSessionKeyForProvider } from "./browser/session-store.js";

/**
 * Site upsert payload threaded through the run store during /setup. Extends the
 * db helper's WorkspaceSiteUpsertInput with the GA4 source link so the store can
 * back-fill workspace_sites.ga4_source_id once a GA4 source is connected. The db
 * helper ignores the extra field; the store writes the FK with a scoped UPDATE.
 */
export type SetupSiteUpsert = WorkspaceSiteUpsertInput & { ga4SourceId?: string };

export interface SetupRunStore {
  startOrResume(workspaceId: string, tool: string): Promise<{ runId: string; resumed: boolean }>;
  recordPhase(runId: string, verb: Verb, result: PhaseResult): Promise<void>;
  finish(runId: string, status: "succeeded" | "paused_handoff" | "failed"): Promise<void>;
  recordSetupState?(
    runId: string,
    update: {
      interview?: SetupInterview;
      selectedProviders?: SetupProviderId[];
      recommendedProviders?: SetupProviderId[];
      provider?: SetupProviderId;
      providerState?: Partial<ProviderRunState>;
      site?: SetupSiteUpsert;
      pendingHandoff?: Record<string, unknown> | null;
      browserProfile?: string | null;
    }
  ): Promise<void>;
}

export interface SetupRunResult {
  tool: string;
  status: "succeeded" | "paused_handoff" | "failed";
  phases: Record<Verb, PhaseResult>;
  providerState?: Partial<ProviderRunState>;
}

export interface SetupExecutionOptions extends RunOptions {
  interview?: SetupInterview;
  selectedProviders?: SetupProviderId[];
  recommendedProviders?: SetupProviderId[];
  inventory?: ProviderInventoryRow;
}

const EXECUTION_ORDER: Array<Exclude<Verb, "detect">> = ["setup", "connect", "sync", "implement"];

export async function runSetup(
  provisioner: Provisioner,
  ctx: ProvisionerContext,
  store: SetupRunStore,
  opts: SetupExecutionOptions = {}
): Promise<SetupRunResult> {
  const { runId } = await store.startOrResume(ctx.workspaceId, provisioner.tool);
  await persistInitialSetupState(store, runId, provisioner.tool, opts);
  const detected = normalizeDetect(await provisioner.detect(ctx));
  let state = detected.state;
  ctx.log({ phase: "detect", status: detected.result.status, detail: detected.result.detail });
  const plan = reconcile(state, opts);
  const phases = {} as Record<Verb, PhaseResult>;
  phases.detect = detected.result;
  let snapshot = detected.snapshot;

  await persistSetupState(store, runId, provisioner.tool, opts, phases, snapshot, phases.detect);

  if (phases.detect.status === "needs_human") {
    await store.finish(runId, "paused_handoff");
    return {
      tool: provisioner.tool,
      status: "paused_handoff",
      phases,
      providerState: buildProviderState(opts.inventory, phases, snapshot)
    };
  }

  if (phases.detect.status === "error" || phases.detect.status === "blocked") {
    await store.finish(runId, "failed");
    return {
      tool: provisioner.tool,
      status: "failed",
      phases,
      providerState: buildProviderState(opts.inventory, phases, snapshot)
    };
  }

  for (const verb of EXECUTION_ORDER) {
    const action = plan[verb];
    const fn = provisioner[verb];
    if (action === "skip" || !fn) {
      phases[verb] = {
        status: "skipped",
        detail: !fn ? `${verb} not supported by ${provisioner.tool}` : "already satisfied"
      };
      // Even when connect is skipped (GA4 already connected with valid creds),
      // back-fill the site link from the detected source. This is the re-run
      // path for workspaces connected BEFORE this feature shipped: without it
      // they'd never populate ga4_source_id and would forever rely on the
      // lone-connected-source fallback (resolveGa4SourceForSite step 3).
      await persistSetupState(store, runId, provisioner.tool, opts, phases, snapshot, phases[verb], {
        verb,
        sourceId: state.sourceId,
        workspaceId: ctx.workspaceId
      });
      continue;
    }
    const step = normalizePhase(await fn.call(provisioner, ctx, state));
    if (step.state) {
      state = step.state;
    }
    phases[verb] = step.result;
    snapshot = mergeSnapshots(snapshot, step.snapshot);
    ctx.log({ phase: verb, status: step.result.status, detail: step.result.detail });
    await store.recordPhase(runId, verb, step.result);
    await persistSetupState(store, runId, provisioner.tool, opts, phases, snapshot, step.result, {
      verb,
      sourceId: state.sourceId,
      workspaceId: ctx.workspaceId
    });
    if (step.result.status === "needs_human") {
      await store.finish(runId, "paused_handoff");
      return {
        tool: provisioner.tool,
        status: "paused_handoff",
        phases,
        providerState: buildProviderState(opts.inventory, phases, snapshot)
      };
    }
    if (step.result.status === "error" || step.result.status === "blocked") {
      await store.finish(runId, "failed");
      return {
        tool: provisioner.tool,
        status: "failed",
        phases,
        providerState: buildProviderState(opts.inventory, phases, snapshot)
      };
    }
  }
  await store.finish(runId, "succeeded");
  return {
    tool: provisioner.tool,
    status: "succeeded",
    phases,
    providerState: buildProviderState(opts.inventory, phases, snapshot)
  };
}

async function persistInitialSetupState(
  store: SetupRunStore,
  runId: string,
  provider: string,
  opts: SetupExecutionOptions
): Promise<void> {
  if (!store.recordSetupState || !isSetupProviderId(provider)) {
    return;
  }

  await store.recordSetupState(runId, {
    interview: opts.interview,
    selectedProviders: opts.selectedProviders,
    recommendedProviders: opts.recommendedProviders,
    provider,
    providerState: buildProviderState(opts.inventory, {}, {})
  });
}

function normalizeDetect(
  output: DetectionState | ProvisionerDetectResult
): { state: DetectionState; result: PhaseResult; snapshot: ProvisionerStateSnapshot } {
  if ("state" in output && "result" in output) {
    const { state, result, ...snapshot } = output;
    return { state, result, snapshot };
  }

  return {
    state: output,
    result: { status: "ok", detail: "detected" },
    snapshot: {}
  };
}

function normalizePhase(
  output: PhaseResult | ProvisionerPhaseResult
): { result: PhaseResult; state?: DetectionState; snapshot: ProvisionerStateSnapshot } {
  if ("result" in output) {
    const { result, state, ...snapshot } = output;
    return { result, state, snapshot };
  }

  return {
    result: output,
    snapshot: {}
  };
}

function mergeSnapshots(
  base: ProvisionerStateSnapshot,
  next: ProvisionerStateSnapshot
): ProvisionerStateSnapshot {
  return {
    publicArtifacts: next.publicArtifacts ?? base.publicArtifacts,
    secretRefs: next.secretRefs ?? base.secretRefs,
    browser: next.browser ?? base.browser,
    verification: next.verification ?? base.verification
  };
}

function buildProviderState(
  inventory: ProviderInventoryRow | undefined,
  phases: Partial<Record<Verb, PhaseResult>>,
  snapshot: ProvisionerStateSnapshot
): Partial<ProviderRunState> {
  return {
    ...(inventory ? { inventory } : {}),
    phases,
    ...(snapshot.publicArtifacts ? { publicArtifacts: snapshot.publicArtifacts } : {}),
    ...(snapshot.secretRefs ? { secretRefs: snapshot.secretRefs } : {}),
    ...(snapshot.browser ? { browser: snapshot.browser } : {}),
    ...(snapshot.verification ? { verification: snapshot.verification } : {})
  };
}

async function persistSetupState(
  store: SetupRunStore,
  runId: string,
  provider: string,
  opts: SetupExecutionOptions,
  phases: Partial<Record<Verb, PhaseResult>>,
  snapshot: ProvisionerStateSnapshot,
  latestResult: PhaseResult,
  siteLink?: { verb: Verb; sourceId?: string; workspaceId: string }
): Promise<void> {
  if (!store.recordSetupState || !isSetupProviderId(provider)) {
    return;
  }

  const pendingHandoff = buildPendingHandoff(runId, provider, latestResult, snapshot.browser);
  const browserProfile =
    pendingHandoff && isRecord(pendingHandoff.browser)
      ? asOptionalString(pendingHandoff.browser.profileRef)
      : undefined;

  const site = buildSiteLink(provider, opts, latestResult, siteLink);

  await store.recordSetupState(runId, {
    interview: opts.interview,
    selectedProviders: opts.selectedProviders,
    recommendedProviders: opts.recommendedProviders,
    provider,
    providerState: buildProviderState(opts.inventory, phases, snapshot),
    ...(site ? { site } : {}),
    pendingHandoff,
    browserProfile: browserProfile ?? snapshot.browser?.profileRef ?? null
  });
}

/**
 * Build the workspace_sites upsert that links the primary site to the GA4
 * source. Emitted ONLY when:
 *   - provider is ga4,
 *   - this persistence is for the connect verb,
 *   - the connect either succeeded (ok/repair) OR was skipped because the source
 *     was already connected with valid creds ("skipped" — this back-fills the
 *     link on idempotent re-runs of a source connected before this feature
 *     shipped). needs_human/blocked/error have no real source and are excluded.
 *   - a real sourceId exists (from connect/reconnect, or carried by detect on the
 *     skip path), and
 *   - the interview carried a websiteUrl (so the primary site row resolves).
 */
function buildSiteLink(
  provider: SetupProviderId,
  opts: SetupExecutionOptions,
  latestResult: PhaseResult,
  siteLink: { verb: Verb; sourceId?: string; workspaceId: string } | undefined
): SetupSiteUpsert | undefined {
  if (provider !== "ga4" || !siteLink || siteLink.verb !== "connect") {
    return undefined;
  }
  if (
    latestResult.status !== "ok" &&
    latestResult.status !== "repair" &&
    latestResult.status !== "skipped"
  ) {
    return undefined;
  }
  const sourceId = asOptionalString(siteLink.sourceId);
  const url = asOptionalString(opts.interview?.websiteUrl);
  if (!sourceId || !url) {
    return undefined;
  }
  return { workspaceId: siteLink.workspaceId, url, ga4SourceId: sourceId };
}

function isSetupProviderId(provider: string): provider is SetupProviderId {
  return provider === "ga4" || provider === "posthog" || provider === "x";
}

function buildPendingHandoff(
  runId: string,
  provider: SetupProviderId,
  latestResult: PhaseResult,
  browser: SetupBrowserHandoffRef | undefined
): Record<string, unknown> | null {
  if (latestResult.status !== "needs_human") {
    return null;
  }

  const data = isRecord(latestResult.data) ? latestResult.data : undefined;
  const resume = sanitizeResumePayload(provider, data?.resume);
  const resolvedBrowser = mergeBrowserHandoffRef(provider, browser, resume, latestResult.handoff?.url);

  return compactRecord({
    provider,
    runId,
    kind: latestResult.handoff?.kind,
    url: sanitizePersistedHandoffUrl(latestResult.handoff?.url),
    instructions: latestResult.handoff?.instructions ?? latestResult.detail,
    reason: asOptionalString(data?.reason),
    ...(resume ? { resume } : {}),
    ...(resolvedBrowser ? { browser: resolvedBrowser } : {})
  });
}

function sanitizeResumePayload(
  provider: SetupProviderId,
  value: unknown
): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const allowedKeys = [
    "status",
    "phase",
    "step",
    "nextAction",
    "source",
    "accountTicketId",
    "redirectUri",
    "profileRef",
    "resumeNonce",
    "lastKnownUrl",
    "handoffUrl",
    "sessionKey",
    "oauthSessionId"
  ] as const;
  const sanitized = Object.fromEntries(allowedKeys
    .map((key) => {
      if (key === "sessionKey") {
        return [key, browserSessionKeyForProvider(asOptionalString(value[key]), provider)] as const;
      }
      return [key, asOptionalString(value[key])] as const;
    })
    .filter((entry): entry is [typeof allowedKeys[number], string] => Boolean(entry[1])));

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function mergeBrowserHandoffRef(
  provider: SetupProviderId,
  browser: SetupBrowserHandoffRef | undefined,
  resume: Record<string, string> | undefined,
  handoffUrl: string | undefined
): SetupBrowserHandoffRef | undefined {
  const merged = compactRecord({
    profileRef: browser?.profileRef ?? resume?.profileRef,
    handoffUrl: sanitizePersistedHandoffUrl(browser?.handoffUrl ?? resume?.handoffUrl ?? handoffUrl),
    resumeNonce: browser?.resumeNonce ?? resume?.resumeNonce,
    lastUrl: sanitizePersistedHandoffUrl(browser?.lastUrl ?? resume?.lastKnownUrl ?? handoffUrl),
    sessionKey: browserSessionKeyForProvider(browser?.sessionKey ?? resume?.sessionKey, provider)
  });

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, candidate]) => candidate !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizePersistedHandoffUrl(value: unknown): string | undefined {
  const candidate = asOptionalString(value);
  if (!candidate) {
    return undefined;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}
