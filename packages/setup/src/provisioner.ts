import type { ActionEnvelope, InfiniteOsActionId, SessionContext } from "@infinite-os/runtime";

import type { LocalBrowserFactory } from "./browser/types.js";
import {
  connectGa4Contract,
  detectGa4Contract,
  implementGa4Contract,
  setupGa4Contract,
  syncGa4Contract,
  type Ga4Dependencies,
  type Ga4PropertyCandidate,
  type Ga4PropertySelection,
  type Ga4PropertySelector
} from "./providers/ga4.js";
import {
  connectPostHogContract,
  detectPostHogContract,
  setupPostHogContract,
  syncPostHogContract,
  type PostHogDependencies
} from "./providers/posthog.js";
import {
  connectXContract,
  detectXContract,
  setupXContract,
  syncXContract,
  type XDependencies
} from "./providers/x.js";
import type {
  AuthRung,
  DetectionState,
  PhaseResult,
  SetupBrowserHandoffRef,
  SetupInterview,
  SetupProviderPublicArtifacts,
  SetupSecretRefs,
  SetupVerificationState,
  ToolId,
  Verb
} from "./types.js";

export interface ActionRunner {
  execute(id: InfiniteOsActionId, input: unknown, ctx: SessionContext): Promise<ActionEnvelope>;
}

export interface Prompter {
  ask(question: string, choices?: string[]): Promise<string>;
  note(message: string): void; // founder-facing copy (v6 §5.3)
}

export interface ProvisionerContext {
  workspaceId: string;
  browser: LocalBrowserFactory;
  actions: ActionRunner;
  prompt: Prompter;
  repoRoot?: string;
  log: (event: { phase: Verb | "detect"; status: string; detail?: string }) => void;
  setup?: Partial<Pick<SetupInterview, "projectName" | "websiteUrl" | "productSurface">> & {
    timeZone?: string;
  };
}

export interface ProvisionerStateSnapshot {
  publicArtifacts?: SetupProviderPublicArtifacts;
  secretRefs?: SetupSecretRefs;
  browser?: SetupBrowserHandoffRef;
  verification?: SetupVerificationState;
}

export interface ProvisionerDetectResult extends ProvisionerStateSnapshot {
  state: DetectionState;
  result: PhaseResult;
}

export interface ProvisionerPhaseResult extends ProvisionerStateSnapshot {
  result: PhaseResult;
  state?: DetectionState;
}

export interface Provisioner {
  tool: ToolId;
  friction: "green" | "amber";
  capabilities: Partial<Record<Verb, { rung: AuthRung; automatable: boolean }>>;
  detect(ctx: ProvisionerContext): Promise<DetectionState | ProvisionerDetectResult>;
  setup?(ctx: ProvisionerContext, state: DetectionState): Promise<PhaseResult | ProvisionerPhaseResult>;
  connect?(ctx: ProvisionerContext, state: DetectionState): Promise<PhaseResult | ProvisionerPhaseResult>;
  sync?(ctx: ProvisionerContext, state: DetectionState): Promise<PhaseResult | ProvisionerPhaseResult>;
  implement?(ctx: ProvisionerContext, state: DetectionState): Promise<PhaseResult | ProvisionerPhaseResult>;
}

export function createGa4Provisioner(
  deps: Ga4Dependencies,
  defaults: { projectName?: string; websiteUrl?: string; timeZone?: string } = {}
): Provisioner {
  let detected: Awaited<ReturnType<typeof detectGa4Contract>> | null = null;

  return {
    tool: "ga4",
    friction: "green",
    capabilities: {
      detect: { rung: "oauth_loopback", automatable: true },
      setup: { rung: "oauth_loopback", automatable: true },
      connect: { rung: "oauth_loopback", automatable: true },
      sync: { rung: "api", automatable: true },
      implement: { rung: "api", automatable: true }
    },
    async detect(ctx) {
      detected = await detectGa4Contract(deps, {
        websiteUrl: ctx.setup?.websiteUrl ?? defaults.websiteUrl,
        selectProperty: makeGa4PromptSelector(ctx.prompt)
      });
      return detected;
    },
    async setup(ctx) {
      detected ??= await detectGa4Contract(deps, {
        websiteUrl: ctx.setup?.websiteUrl ?? defaults.websiteUrl,
        selectProperty: makeGa4PromptSelector(ctx.prompt)
      });
      detected = await setupGa4Contract(deps, detected, {
        projectName: ctx.setup?.projectName ?? defaults.projectName ?? ctx.workspaceId,
        websiteUrl: ctx.setup?.websiteUrl ?? defaults.websiteUrl ?? "",
        timeZone: ctx.setup?.timeZone ?? defaults.timeZone,
        note: (message) => ctx.prompt.note(message)
      });
      return detected;
    },
    async connect(ctx, state) {
      detected ??= await detectGa4Contract(deps, {
        websiteUrl: ctx.setup?.websiteUrl ?? defaults.websiteUrl,
        selectProperty: makeGa4PromptSelector(ctx.prompt)
      });
      detected = await connectGa4Contract(ctx, detected, state);
      return detected;
    },
    async sync(ctx, state) {
      detected ??= await detectGa4Contract(deps, {
        websiteUrl: ctx.setup?.websiteUrl ?? defaults.websiteUrl,
        selectProperty: makeGa4PromptSelector(ctx.prompt)
      });
      detected = await syncGa4Contract(ctx, detected, state);
      return detected;
    },
    async implement(ctx, state) {
      detected ??= await detectGa4Contract(deps, {
        websiteUrl: ctx.setup?.websiteUrl ?? defaults.websiteUrl,
        selectProperty: makeGa4PromptSelector(ctx.prompt)
      });
      const measurementId = detected.publicArtifacts?.measurementId;
      if (!measurementId) {
        return {
          result: {
            status: "skipped",
            detail: "No Measurement ID — run setup first."
          },
          state
        };
      }
      if (!ctx.repoRoot) {
        return {
          result: {
            status: "blocked",
            detail: "No repo root available for tag install."
          },
          state
        };
      }
      const { planInstallation, applyInstallation } = await import("infinite-tag");
      const outcome = await implementGa4Contract(
        { measurementId, repoRoot: ctx.repoRoot, workspaceId: ctx.workspaceId },
        { planInstallation, applyInstallation }
      );
      return {
        ...outcome,
        publicArtifacts: detected.publicArtifacts,
        secretRefs: detected.secretRefs,
        state
      };
    }
  };
}

const GA4_MORE_OPTIONS_LABEL = "Don't see the right account? More options…";
const GA4_CREATE_ACCOUNT_LABEL =
  "➕ Create a new Google Analytics account (browser step — pauses setup)";
const GA4_BACK_LABEL = "← Back";
/** Main-picker rounds before giving up on More-options bouncing and taking the safe default. */
const GA4_MAX_PICKER_ROUNDS = 3;

/**
 * Adapts the founder {@link Prompter} into a GA4 property selector. Only invoked
 * when detection is ambiguous; the first choice is the prompter's default (Enter /
 * non-interactive), so it is kept safe: a real site match if one exists, otherwise
 * creating a fresh property for the site — never silently another product's data.
 */
export function makeGa4PromptSelector(prompt: Prompter): Ga4PropertySelector {
  return async ({ websiteUrl, candidates, accounts }) => {
    const siteLabel = hostLabel(websiteUrl);
    const matched = candidates.filter((candidate) => candidate.matchesSite);
    const ordered =
      matched.length > 0
        ? [...matched, ...candidates.filter((candidate) => !candidate.matchesSite)]
        : candidates;

    const useEntries = ordered.map((candidate) => ({
      label: ga4CandidateLabel(candidate),
      selection: {
        kind: "use_property",
        accountId: candidate.accountId,
        propertyId: candidate.propertyId,
        displayName: candidate.displayName,
        stream: candidate.stream
      } as Ga4PropertySelection
    }));

    const fallbackAccountId = accounts[0]?.accountId ?? candidates[0]?.accountId ?? "";
    const createPropertyEntry = {
      label: `➕ Create a new GA4 property for ${siteLabel} (Infinite creates it for you now)`,
      selection: { kind: "create_property", accountId: fallbackAccountId } as Ga4PropertySelection
    };

    const entries =
      matched.length > 0
        ? [...useEntries, createPropertyEntry]
        : [createPropertyEntry, ...useEntries];
    const mainLabels = [...entries.map((entry) => entry.label), GA4_MORE_OPTIONS_LABEL];

    // The create-account row is the ONE inherently manual path (Google requires a
    // human to accept the Analytics ToS), so it never sits on the main picker where
    // an arrow-key mis-commit could land on it — it lives behind "More options…".
    // Back (or an unrecognized sub-step answer) re-shows the main picker; the loop
    // is capped so a prompter that never returns a known answer still terminates
    // on the safe default.
    let selection: Ga4PropertySelection | undefined;
    for (let round = 0; round < GA4_MAX_PICKER_ROUNDS && !selection; round += 1) {
      const answer = await prompt.ask(
        `Which Google Analytics property should Infinite use for ${siteLabel}?`,
        mainLabels
      );
      if (answer === GA4_MORE_OPTIONS_LABEL) {
        const subAnswer = await prompt.ask("More Google Analytics options:", [
          GA4_CREATE_ACCOUNT_LABEL,
          GA4_BACK_LABEL
        ]);
        if (subAnswer === GA4_CREATE_ACCOUNT_LABEL) {
          selection = { kind: "create_account" };
        }
        continue;
      }
      // Resolve by exact label; fall back to entries[0] (the safe default) if a prompter
      // ever returns something outside the offered choices.
      selection = (entries.find((entry) => entry.label === answer) ?? entries[0]!).selection;
    }
    selection ??= entries[0]!.selection;
    if (selection.kind === "create_property" && accounts.length > 1) {
      const accountLabels = accounts.map(
        (account) => `${account.accountName ?? account.accountId} — ${account.accountId}`
      );
      const accountAnswer = await prompt.ask(
        "Which Google Analytics account should the new property live under?",
        accountLabels
      );
      const index = accountLabels.indexOf(accountAnswer);
      const account = accounts[index >= 0 ? index : 0]!;
      selection = { kind: "create_property", accountId: account.accountId };
    }

    // Echo the committed choice. The arrow-key picker repaints heavily in some
    // terminals, so a mis-selection is otherwise invisible until the wrong
    // outcome happens (e.g. an unexpected pause-for-browser handoff).
    if (selection.kind === "use_property") {
      prompt.note(
        `GA4: using the existing property ${selection.displayName ?? selection.propertyId} — ${selection.propertyId}.`
      );
    } else if (selection.kind === "create_property") {
      prompt.note(`GA4: creating a new property for ${siteLabel} now — no browser step needed.`);
    } else {
      prompt.note(
        "GA4: you chose to create a new Google Analytics account — setup pauses while you do that in the browser, then resume."
      );
    }
    return selection;
  };
}

function ga4CandidateLabel(candidate: Ga4PropertyCandidate): string {
  const name = candidate.displayName ?? candidate.propertyId;
  const account = candidate.accountName ? ` · ${candidate.accountName}` : "";
  // Surface the Measurement ID so two same-named/same-host properties (e.g. prod vs
  // staging) are distinguishable in the picker.
  const measurement = candidate.stream?.measurementId ? ` · ${candidate.stream.measurementId}` : "";
  const match = candidate.matchesSite ? " (matches your site)" : "";
  return `${name} — ${candidate.propertyId}${account}${measurement}${match}`;
}

function hostLabel(websiteUrl: string | undefined): string {
  if (!websiteUrl) {
    return "your site";
  }
  const candidate = websiteUrl.includes("://") ? websiteUrl : `https://${websiteUrl}`;
  try {
    return new URL(candidate).hostname.replace(/^www\./i, "");
  } catch {
    return websiteUrl;
  }
}

export function createPostHogProvisioner(
  deps: PostHogDependencies,
  defaults: { projectName?: string } = {}
): Provisioner {
  let detected: Awaited<ReturnType<typeof detectPostHogContract>> | null = null;

  return {
    tool: "posthog",
    friction: "green",
    capabilities: {
      detect: { rung: "browser_assist", automatable: false },
      setup: { rung: "browser_assist", automatable: false },
      connect: { rung: "browser_assist", automatable: false },
      sync: { rung: "api", automatable: true }
    },
    async detect(ctx) {
      detected = await detectPostHogContract(deps, {
        projectName: ctx.setup?.projectName ?? defaults.projectName ?? ctx.workspaceId
      });
      return detected;
    },
    async setup(ctx) {
      detected ??= await detectPostHogContract(deps, {
        projectName: ctx.setup?.projectName ?? defaults.projectName ?? ctx.workspaceId
      });
      detected = await setupPostHogContract(deps, detected, {
        projectName: ctx.setup?.projectName ?? defaults.projectName ?? ctx.workspaceId
      });
      return detected;
    },
    async connect(ctx, state) {
      detected ??= await detectPostHogContract(deps, {
        projectName: ctx.setup?.projectName ?? defaults.projectName ?? ctx.workspaceId
      });
      detected = await connectPostHogContract(ctx, detected, state);
      return detected;
    },
    async sync(ctx, state) {
      detected ??= await detectPostHogContract(deps, {
        projectName: ctx.setup?.projectName ?? defaults.projectName ?? ctx.workspaceId
      });
      detected = await syncPostHogContract(ctx, detected, state);
      return detected;
    }
  };
}

export function createXProvisioner(
  deps: XDependencies,
  defaults: { websiteUrl?: string } = {}
): Provisioner {
  let detected: Awaited<ReturnType<typeof detectXContract>> | null = null;

  return {
    tool: "x",
    friction: "amber",
    capabilities: {
      detect: { rung: "browser_assist", automatable: false },
      setup: { rung: "browser_assist", automatable: false },
      connect: { rung: "browser_assist", automatable: false },
      sync: { rung: "api", automatable: true }
    },
    async detect(ctx) {
      detected = await detectXContract(deps, {
        websiteUrl: ctx.setup?.websiteUrl ?? defaults.websiteUrl
      });
      return detected;
    },
    async setup(ctx) {
      detected ??= await detectXContract(deps, {
        websiteUrl: ctx.setup?.websiteUrl ?? defaults.websiteUrl
      });
      detected = await setupXContract(deps, detected, {
        websiteUrl: ctx.setup?.websiteUrl ?? defaults.websiteUrl
      });
      return detected;
    },
    async connect(ctx, state) {
      detected ??= await detectXContract(deps, {
        websiteUrl: ctx.setup?.websiteUrl ?? defaults.websiteUrl
      });
      detected = await connectXContract(ctx, detected, state);
      return detected;
    },
    async sync(ctx, state) {
      detected ??= await detectXContract(deps, {
        websiteUrl: ctx.setup?.websiteUrl ?? defaults.websiteUrl
      });
      detected = await syncXContract(ctx, detected, state);
      return detected;
    }
  };
}
