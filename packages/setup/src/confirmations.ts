import { buildInstrumentInstallCommand } from "./install-command.js";
import type { OnboardingResult } from "./onboarding-controller.js";
import type { SetupRunResult } from "./setup-controller.js";
import type {
  PhaseResult,
  SetupInterview,
  SetupProviderId,
  SetupProviderPublicArtifacts
} from "./types.js";

const PROVIDER_LABELS: Record<SetupProviderId, string> = {
  ga4: "GA4",
  posthog: "PostHog",
  x: "X"
};

/** What `npx infinite-tag install` drops into the founder's site for each provider. */
const PROVIDER_TAG_NOUNS: Record<SetupProviderId, string> = {
  ga4: "GA4 tag",
  posthog: "PostHog snippet",
  x: "X pixel"
};

/** The public artifact the installer cannot work without, per provider. */
const PROVIDER_INSTALL_ID_NOUNS: Record<SetupProviderId, string> = {
  ga4: "Measurement ID",
  posthog: "project key",
  x: "pixel id"
};

export interface ProviderConfirmationInput {
  provider: SetupProviderId;
  /** The provider's onboarding run; omit when the provider was skipped entirely. */
  run?: Pick<SetupRunResult, "status" | "phases" | "providerState">;
  workspaceId: string;
  /** Active setup run id when the provider paused on a handoff (renders the resume command). */
  runId?: string;
}

/**
 * One founder-facing line per provider after its `infinite setup` step: a ✓/✗/→
 * status, WHAT was captured or connected, and the concrete NEXT step (copy-paste
 * install or resume command). Pure and deterministic so it is unit-testable.
 */
export function formatProviderConfirmation(input: ProviderConfirmationInput): string {
  const label = PROVIDER_LABELS[input.provider];
  if (!input.run) {
    return `– ${label} skipped — nothing was set up or captured for it in this run. Next: run \`infinite setup\` again to include it.`;
  }
  switch (input.run.status) {
    case "succeeded":
      return formatSucceeded(input.provider, label, input.run, input.workspaceId);
    case "paused_handoff":
      return formatPaused(label, input.runId);
    default:
      return formatFailed(label, input.run.phases);
  }
}

/**
 * Confirmations for every provider the founder selected in this onboarding pass,
 * in interview order. Paused providers resolve their resume command from the
 * matching active run.
 */
export function buildProviderConfirmations(input: {
  interview: SetupInterview;
  runs: OnboardingResult["runs"];
  activeRuns: Array<{ id: string; provider?: string; status?: string }>;
  workspaceId: string;
}): string[] {
  const pausedRunIds = new Map<string, string>();
  for (const run of input.activeRuns) {
    // activeRuns is ordered most-recent first; keep the first id per provider.
    if (run.provider && run.status === "paused_handoff" && !pausedRunIds.has(run.provider)) {
      pausedRunIds.set(run.provider, run.id);
    }
  }

  return input.interview.providerInventory
    .filter((row) => row.selected)
    .map((row) =>
      formatProviderConfirmation({
        provider: row.provider,
        run: input.runs[row.provider],
        workspaceId: input.workspaceId,
        runId: pausedRunIds.get(row.provider)
      })
    );
}

function formatSucceeded(
  provider: SetupProviderId,
  label: string,
  run: NonNullable<ProviderConfirmationInput["run"]>,
  workspaceId: string
): string {
  const artifacts = run.providerState?.publicArtifacts ?? undefined;
  const captured = describeCapturedArtifacts(provider, artifacts);
  const status = `✓ ${label} connected${captured ? ` — ${captured}` : ""}.`;
  // The founder runs this inside their own website repo (--root defaults to cwd there).
  const installCommand = buildInstrumentInstallCommand({
    workspaceId,
    artifacts: { [provider]: artifacts }
  });
  if (!installCommand) {
    return `${status} Next: re-run \`infinite setup\` to capture its ${PROVIDER_INSTALL_ID_NOUNS[provider]} — nothing to install yet.`;
  }
  // Point at the single COMBINED command printed at the end of setup. A per-provider
  // `--yes` command here could clobber another provider's tag if pasted in sequence
  // (each rewrites the managed analytics module with only its own flags).
  return `${status} Next: use the install command at the end of this setup (covers all connected providers).`;
}

function formatPaused(label: string, runId: string | undefined): string {
  const resume = runId
    ? `run \`infinite setup resume ${runId}\``
    : "run `infinite setup status` to get the resume command";
  return `→ ${label} not connected yet — setup paused for a step in your browser. Next: finish that step, then ${resume}.`;
}

function formatFailed(label: string, phases: Partial<Record<string, PhaseResult>>): string {
  const detail = firstFailureDetail(phases);
  const status = detail ? `✗ ${label} failed — ${trimTrailingPeriod(detail)}.` : `✗ ${label} failed.`;
  return `${status} Next: fix the issue above, then run \`infinite setup\` again.`;
}

function describeCapturedArtifacts(
  provider: SetupProviderId,
  artifacts: SetupProviderPublicArtifacts | undefined
): string {
  const parts: string[] = [];
  if (provider === "ga4") {
    if (artifacts?.propertyId) {
      parts.push(`property ${artifacts.propertyId}`);
    }
    if (artifacts?.measurementId) {
      parts.push(`Measurement ID ${artifacts.measurementId}`);
    }
  } else if (provider === "posthog") {
    if (artifacts?.projectKey) {
      parts.push(`project key ${artifacts.projectKey} captured + pixel ready`);
    }
    if (artifacts?.projectId) {
      parts.push(`project ${artifacts.projectId}`);
    }
  } else if (artifacts?.pixelId) {
    parts.push(`pixel id ${artifacts.pixelId} captured`);
  }
  return parts.join(" · ");
}

function firstFailureDetail(phases: Partial<Record<string, PhaseResult>>): string | undefined {
  for (const phase of Object.values(phases)) {
    if (phase && (phase.status === "error" || phase.status === "blocked") && phase.detail) {
      return phase.detail;
    }
  }
  return undefined;
}

function trimTrailingPeriod(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}
