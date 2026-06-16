import type { Provisioner, ProvisionerContext } from "./provisioner.js";
import {
  buildSetupRecommendations,
  selectRecommendedV1Providers,
  type SetupRecommendation
} from "./recommendations.js";
import { runSetup, type SetupRunResult, type SetupRunStore } from "./setup-controller.js";
import type { SetupInterview, SetupProviderId } from "./types.js";

export interface OnboardingResult {
  recommendations: SetupRecommendation[];
  selectedProviders: SetupProviderId[];
  recommendedProviders: SetupProviderId[];
  completed: SetupProviderId[]; // succeeded -> fed to the single codemod pass
  paused: SetupProviderId[]; // awaiting a handoff; re-run /setup to resume
  failed: SetupProviderId[];
  runs: Partial<Record<SetupProviderId, SetupRunResult>>;
}

export async function runOnboarding(
  input: { interview: SetupInterview; provisioners: Provisioner[] },
  ctx: ProvisionerContext,
  store: SetupRunStore
): Promise<OnboardingResult> {
  const recommendationMap = new Map(
    buildSetupRecommendations({
      productSurface: input.interview.productSurface,
      founderRequestedProviders: input.interview.providerInventory
        .filter((row) => row.selected)
        .map((row) => row.provider),
      existingProviders: Object.fromEntries(
        input.interview.providerInventory.map((row) => [
          row.provider,
          { hasAccount: row.hasAccount, installState: row.installState }
        ])
      )
    }).map((recommendation) => [recommendation.provider, recommendation] as const)
  );
  const recommendations = Array.from(recommendationMap.values());
  const recommendedProviders = selectRecommendedV1Providers(recommendations);
  const selectedInventory = new Map(
    input.interview.providerInventory.map((row) => [row.provider, row] as const)
  );
  const selectedProviders = dedupeSelectedProviders(
    input.provisioners,
    selectedInventory,
    recommendationMap
  );
  const result: OnboardingResult = {
    recommendations,
    selectedProviders,
    recommendedProviders,
    completed: [],
    paused: [],
    failed: [],
    runs: {}
  };
  const setupCtx: ProvisionerContext = {
    ...ctx,
    setup: {
      ...ctx.setup,
      projectName: input.interview.projectName,
      websiteUrl: input.interview.websiteUrl,
      productSurface: input.interview.productSurface
    }
  };

  for (const provisioner of input.provisioners) {
    if (!selectedProviders.includes(provisioner.tool as SetupProviderId)) {
      continue;
    }

    const inventory = selectedInventory.get(provisioner.tool as SetupProviderId);
    // skipImplement: the single codemod pass wires all completed tools afterward (v6 §5/§7.3).
    const run = await runSetup(provisioner, setupCtx, store, {
      interview: input.interview,
      selectedProviders,
      recommendedProviders,
      skipImplement: true,
      inventory
    });
    result.runs[provisioner.tool as SetupProviderId] = run;
    if (run.status === "succeeded") result.completed.push(provisioner.tool as SetupProviderId);
    else if (run.status === "paused_handoff") result.paused.push(provisioner.tool as SetupProviderId); // collect + continue
    else result.failed.push(provisioner.tool as SetupProviderId);
  }
  return result;
}

function dedupeSelectedProviders(
  provisioners: Provisioner[],
  selectedInventory: Map<SetupProviderId, SetupInterview["providerInventory"][number]>,
  recommendations: Map<SetupRecommendation["provider"], SetupRecommendation>
): SetupProviderId[] {
  const selected: SetupProviderId[] = [];
  const seen = new Set<SetupProviderId>();

  for (const provisioner of provisioners) {
    if (!isSetupProviderId(provisioner.tool) || seen.has(provisioner.tool)) {
      continue;
    }

    const inventory = selectedInventory.get(provisioner.tool);
    const recommendation = recommendations.get(provisioner.tool);
    if (!inventory?.selected || recommendation?.status !== "recommended" || !recommendation.implementable) {
      continue;
    }

    selected.push(provisioner.tool);
    seen.add(provisioner.tool);
  }

  return selected;
}

function isSetupProviderId(provider: string): provider is SetupProviderId {
  return provider === "ga4" || provider === "posthog" || provider === "x";
}
