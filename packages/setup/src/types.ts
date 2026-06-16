export type ToolId = "ga4" | "posthog" | "meta" | "x" | "stripe";
export type Verb = "detect" | "setup" | "connect" | "sync" | "implement";
export type AuthRung = "api" | "oauth_loopback" | "oauth_in_window" | "browser_assist";
export type PhaseStatus = "ok" | "skipped" | "repair" | "needs_human" | "blocked" | "error";
export type SetupProviderId = Extract<ToolId, "ga4" | "posthog" | "x">;
export type ProductSurface = "web" | "mobile";
export type ProviderInstallState = "installed" | "not_installed" | "unknown";

export interface ProviderInventoryRow {
  provider: SetupProviderId;
  hasAccount: boolean;
  installState: ProviderInstallState;
  selected: boolean;
  recommended: boolean;
}

export interface SetupInterview {
  projectName: string;
  productDescription?: string;
  websiteUrl?: string;
  productSurface: ProductSurface;
  providerInventory: ProviderInventoryRow[];
}

export interface SetupInterviewInput {
  projectName?: string;
  productDescription?: string | null;
  websiteUrl?: string | null;
  productSurface?: ProductSurface | null;
  providerInventory?: Iterable<Partial<ProviderInventoryRow> & Pick<ProviderInventoryRow, "provider">>;
}

export interface SetupSecretRefs {
  oauthAppId?: string;
  oauthTokenId?: string;
  connectionCredentialId?: string;
}

export interface SetupVerificationState {
  installStatus: "pending" | "verified" | "failed";
  queryabilityStatus: "pending" | "verified" | "failed";
  lastCheckedAt?: string;
}

export interface SetupBrowserHandoffRef {
  profileRef?: string;
  handoffUrl?: string;
  resumeNonce?: string;
  lastUrl?: string;
  sessionKey?: string;
}

export type SetupPublicArtifactValue =
  | string
  | string[]
  | Record<string, string>
  | null;

export interface SetupProviderPublicArtifacts {
  measurementId?: string | null;
  propertyId?: string | null;
  projectId?: string | null;
  projectKey?: string | null;
  apiHost?: string | null;
  pixelId?: string | null;
  eventTagIds?: Record<string, string> | null;
  [key: string]: SetupPublicArtifactValue | undefined;
}

export interface DetectConflict {
  tool: ToolId;
  field: string;
  detectedValue?: string;
  answeredValue?: string;
  resolution: "ask" | "detection-wins" | "answer-wins";
}

export interface DetectionState {
  accountExists: boolean;
  /**
   * GA4: the founder explicitly chose "create a new account" in the picker even
   * though accounts exist. Setup routes this through provisionAccountTicket (when
   * wired) instead of detect handing off to analytics.google.com. Kept separate
   * from `accountExists` so "account detected" messaging stays truthful.
   */
  requestedNewAccount?: boolean;
  assetExists: boolean;
  assetId?: string; // propertyId | pixelId | projectId
  installId?: string; // measurementId G-XXXX | pixelId | phc_ key | X pixel id
  sourceId?: string; // Infinite OS source, if connected
  credentialValid?: boolean;
  tagInstalled?: boolean;
  tagFiring?: boolean;
  conflicts?: DetectConflict[];
  assets?: Record<string, unknown>;
}

export interface PhaseResult {
  status: PhaseStatus;
  detail: string;
  data?: Record<string, unknown>;
  handoff?: { kind: "window_open" | "open_url"; url?: string; instructions: string };
  caveats?: string[];
}

export interface ProviderRunState {
  inventory: ProviderInventoryRow;
  phases: Partial<Record<Verb, PhaseResult>>;
  publicArtifacts?: SetupProviderPublicArtifacts;
  secretRefs?: SetupSecretRefs;
  browser?: SetupBrowserHandoffRef;
  verification?: SetupVerificationState;
}

export interface SetupRunPhaseState {
  interview: SetupInterview;
  providers: Partial<Record<SetupProviderId, ProviderRunState>>;
  selectedProviders: SetupProviderId[];
  recommendedProviders: SetupProviderId[];
}

export interface RunOptions {
  skipImplement?: boolean; // onboarding defers implement to the single codemod pass
  dryRun?: boolean; // TODO(M1): not yet wired into reconcile()/runSetup()
}

/** What the reconciler decides for each post-detect verb. */
export type VerbAction = "run" | "skip" | "repair";
export interface VerbPlan {
  setup: VerbAction;
  connect: VerbAction;
  sync: VerbAction;
  implement: VerbAction;
}
