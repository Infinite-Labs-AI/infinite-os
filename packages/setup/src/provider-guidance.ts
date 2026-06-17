// Single source of truth for the per-provider "what's about to open" guidance block.
//
// This module is PURE STRINGS — no TTY, no readline, no process access. It is reused
// in three places so just-in-time and resume copy stay identical:
//   1. The CLI prints it right before each browser opens (apps/cli/src/index.ts).
//   2. live.ts prints it before the PostHog browser opens, and on the paused/resume
//      render path (launchPausedHandoffs).
// The shape is consistent: WHAT is opening · WHAT to do (numbered) · WHY (one line) ·
// CONFIRM · SKIP — and, when an authorization URL is known, #7's "paste this link" line.

export type GuidanceProvider = "ga4" | "posthog" | "x";

export type GuidanceStep =
  // GA4
  | "quick_connect" // Infinite's shared Google app (the default OAuth quick-connect)
  | "byo" // bring-your-own Google Cloud app
  | "tos" // GA4 account/property + Terms-of-Service handoff (no OAuth bootstrap)
  // PostHog
  | "api_key" // founder already has a PostHog account: personal API key page
  | "signup" // founder has no PostHog account yet: signup flow
  // X
  | "billing";

export interface ProviderGuidanceContext {
  /**
   * The copy-pasteable OAuth/handoff authorization URL, when known. When present it is
   * rendered as #7's "Didn't open / wrong machine? Paste this link:" line so the user is
   * never stuck if the browser opened on the wrong machine (SSH/remote) or account.
   */
  authorizationUrl?: string;
  /** Run id for the resume hint, when this block is rendered on a paused/resume path. */
  runId?: string;
  /**
   * True when the redirect is a loopback (127.0.0.1) URI AND a remote/SSH session is
   * detected, so the callback lands on 127.0.0.1 of THIS machine, not the browser's.
   * Adds a steering note (the CLI computes this; this module just renders it).
   */
  remoteLoopbackHint?: boolean;
}

const PROVIDER_LABEL: Record<GuidanceProvider, string> = {
  ga4: "Google Analytics",
  posthog: "PostHog",
  x: "X"
};

/** Human label for a provider (e.g. for the "Now connecting <Provider> (N of M)" boundary). */
export function providerDisplayLabel(provider: GuidanceProvider): string {
  return PROVIDER_LABEL[provider];
}

/**
 * The "Now connecting <Provider> (N of M)…" sequencing boundary printed by the CLI
 * just before each provider's browser opens (#8 Part 1). Kept here so the label and
 * framing live with the rest of the per-provider copy.
 */
export function providerHandoffBoundary(provider: GuidanceProvider, index: number, total: number): string {
  return `Now connecting ${PROVIDER_LABEL[provider]} (${index} of ${total})…`;
}

interface GuidanceBody {
  /** First line — WHAT is opening. */
  opening: string;
  /** Numbered "What to do there" steps. */
  steps: string[];
  /** One-line WHY. */
  why: string;
  /** CONFIRM line — what happens when the founder finishes. */
  confirm: string;
  /** SKIP line — how to bail out cleanly. */
  skip: string;
}

function ga4QuickConnectBody(): GuidanceBody {
  return {
    opening: "Connecting Google Analytics — opening your browser now.",
    steps: [
      "Sign in to Google (Infinite never sees your password).",
      "If you see \"Google hasn't verified this app\", click Advanced → Continue (it's Infinite's app, pending Google review).",
      "Approve the Analytics permissions and accept any Terms of Service."
    ],
    why: "lets Infinite create/read your GA4 property + web stream and capture the Measurement ID (G-…) to install on your site.",
    confirm: "this terminal continues automatically once Google redirects back (or press Ctrl-C for more options).",
    skip: "press Ctrl-C to use your own Google Cloud app or install the tag manually later."
  };
}

function ga4ByoBody(): GuidanceBody {
  return {
    opening: "Connecting Google Analytics with your own Google Cloud app — opening your browser now.",
    steps: [
      "Sign in to Google (Infinite never sees your password).",
      "If you see \"Google hasn't verified this app\", click Advanced → Continue (it's your own unverified app — expected, no Google verification needed).",
      "Approve the Analytics permissions and accept any Terms of Service."
    ],
    why: "lets Infinite create/read your GA4 property + web stream and capture the Measurement ID (G-…) to install on your site.",
    confirm: "this terminal continues automatically once Google redirects back (or press Ctrl-C for more options).",
    skip: "press Ctrl-C to install the GA4 tag manually later."
  };
}

function ga4TosBody(hasAccount: boolean): GuidanceBody {
  return {
    opening: hasAccount
      ? "Connecting Google Analytics — opening Google Analytics in your browser now."
      : "Setting up Google Analytics — opening Google Analytics account setup in your browser now.",
    steps: hasAccount
      ? [
          "Sign in to Google Analytics.",
          "Approve access for this workspace and accept any pending Analytics Terms of Service.",
          "In Google Analytics, open the Web data stream for this site and keep the Measurement ID (G-…) visible."
        ]
      : [
          "Sign in to Google and finish Google Analytics account setup.",
          "Accept the Analytics Terms of Service if prompted.",
          "Open the Web data stream for this site and keep the Measurement ID (G-…) visible."
        ],
    why: "GA4 authorization lets Infinite create/read the Analytics property and web stream for sync/query, then store the Measurement ID for site installation.",
    confirm: "resume setup afterward — Infinite keeps this setup run state.",
    skip: "press Ctrl-C to install the GA4 tag manually later."
  };
}

function posthogApiKeyBody(): GuidanceBody {
  return {
    opening: "Connecting PostHog — opening the personal API keys page now.",
    steps: [
      "If Infinite can't auto-create the key, create a scoped personal API key (phx_…).",
      "Copy it."
    ],
    why: "the phx_ key lets Infinite sync your PostHog data server-side (it can't read it from the browser).",
    confirm: "paste it here when prompted, or run `infinite setup resume <run_id>` and paste/import it.",
    skip: "press Enter at the paste prompt to continue without sync for now."
  };
}

function posthogSignupBody(): GuidanceBody {
  return {
    opening: "Setting up PostHog — opening PostHog signup now.",
    steps: [
      "Finish signup, login, or email verification until you reach a PostHog project home page.",
      "Return to this terminal and run resume — Infinite will open the API-key step next."
    ],
    why: "Infinite needs a PostHog project so it can mint a scoped key and sync your product analytics server-side.",
    confirm: "run `infinite setup resume <run_id>` once you reach a PostHog project home page.",
    skip: "you don't need to find the project API key/pixel yet — the next step handles it."
  };
}

function xBillingBody(): GuidanceBody {
  return {
    opening: "Connecting X — opening the X developer portal now.",
    steps: [
      "Mint or copy a bearer token in the X developer portal.",
      "Reconnect the X source with that token."
    ],
    why: "the bearer token lets Infinite read your X ads/analytics data for sync/query.",
    confirm: "run `infinite setup resume <run_id>` after you have the token.",
    skip: "press Enter to skip X for now — it's optional and can be connected later."
  };
}

function bodyFor(provider: GuidanceProvider, step: GuidanceStep, hasAccount: boolean): GuidanceBody {
  if (provider === "ga4") {
    if (step === "byo") return ga4ByoBody();
    if (step === "tos") return ga4TosBody(hasAccount);
    return ga4QuickConnectBody();
  }
  if (provider === "posthog") {
    if (step === "signup") return posthogSignupBody();
    return posthogApiKeyBody();
  }
  return xBillingBody();
}

/**
 * Renders the per-provider guidance block as a single string ready to hand to
 * `prompt.note(...)` / `output.write(...)`. Deterministic given its inputs (snapshot-tested).
 *
 * @param hasAccount only affects the GA4 `tos` variant copy; ignored elsewhere.
 */
export function providerGuidance(
  provider: GuidanceProvider,
  step: GuidanceStep,
  ctx: ProviderGuidanceContext = {},
  hasAccount = true
): string {
  const body = bodyFor(provider, step, hasAccount);
  const lines: string[] = [body.opening, "What to do there:"];
  body.steps.forEach((stepText, index) => {
    lines.push(`  ${index + 1}. ${stepText}`);
  });
  lines.push(`Why: ${body.why}`);
  lines.push(`Confirm: ${body.confirm}`);

  const url = ctx.authorizationUrl?.trim();
  if (url) {
    lines.push(`Didn't open / wrong machine? Paste this link:\n  ${url}`);
    if (ctx.remoteLoopbackHint) {
      lines.push(
        "Remote/SSH note: the sign-in redirect lands on 127.0.0.1 of THIS machine, not your browser's. " +
          "If your browser is on a different machine, use your own Google Cloud app or install the tag manually instead."
      );
    }
  }

  lines.push(`Skip: ${body.skip}`);

  const runId = ctx.runId?.trim();
  if (runId) {
    lines.push(`Resume any time with: infinite setup resume ${runId}`);
  }

  return lines.join("\n");
}
