import { resolveEmbeddedGa4OAuthClient, type EmbeddedGa4OAuthClient } from "./ga4-oauth-client.js";

export interface Ga4ConnectConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}

export interface Ga4ConnectConfigEnv {
  GROWTH_OS_GA4_OAUTH_CLIENT_ID?: string;
  GROWTH_OS_GA4_OAUTH_CLIENT_SECRET?: string;
  GROWTH_OS_GA4_OAUTH_REDIRECT_URI?: string;
}

export interface Ga4ConnectConfigIo {
  write(message: string): void;
  /** Freeform prompt; empty answer falls back to `fallback`, otherwise undefined. */
  promptText(question: string, fallback?: string): Promise<string | undefined>;
  /** Masked prompt with the same fallback semantics as promptText. */
  promptSecret(question: string, fallback?: string): Promise<string | undefined>;
  /** Single-select prompt; Enter returns `defaultIndex`. */
  promptChoice(question: string, choices: string[], defaultIndex: number): Promise<number>;
}

export interface PrepareGa4ConnectConfigOptions {
  env: Ga4ConnectConfigEnv;
  /** True only when stdin is a TTY, the run is not --json, and GROWTH_OS_CLI_NONINTERACTIVE !== "1". */
  interactive: boolean;
  defaultRedirectUri: string;
  /** Reads the release-injected (gitignored) embedded client; null if absent. */
  readReleaseConfig: () => EmbeddedGa4OAuthClient | null;
  io: Ga4ConnectConfigIo;
}

export const GA4_CONNECT_CHOOSER_QUESTION = "How do you want to connect Google Analytics?";
export const GA4_QUICK_CONNECT_CHOICE =
  "Quick connect with Infinite's Google app (~1 min, recommended)";
export const GA4_BYO_APP_CHOICE =
  "Use your own Google Cloud app (~5 min — fully yours, most private)";

const CONNECT_DISCLOSURE_INTRO = [
  "Connecting Google Analytics — a browser window will open for you to sign in.",
  "You'll sign in with Google there. Infinite never sees your password."
];

/** Quick connect uses Infinite's Google app — the unverified screen is about OUR app, not the founder's. */
const QUICK_CONNECT_DISCLOSURE = [
  ...CONNECT_DISCLOSURE_INTRO,
  "In the browser, if Google shows a \"Google hasn't verified this app\" screen, click Advanced → Continue (it's Infinite's app; expected while Google's verification of it is pending).",
  "Quick connect uses Infinite's shared Google app (shared API quota). For full isolation, choose \"use your own Google Cloud app\" instead.",
  ""
].join("\n");

/** Bring-your-own client (guided flow or env vars) — the unverified screen is about the founder's own app. */
const OWN_APP_DISCLOSURE = [
  ...CONNECT_DISCLOSURE_INTRO,
  "In the browser, if Google shows a \"Google hasn't verified this app\" screen, click Advanced → Continue (it's your own unverified app — expected, no Google verification needed).",
  ""
].join("\n");

const BYO_WALKTHROUGH = [
  "Use your own Google Cloud app — about 5 minutes, and the credentials stay fully yours.",
  "",
  "  1. Create or pick a Google Cloud project:",
  "     https://console.cloud.google.com/projectcreate",
  "  2. Enable the \"Google Analytics Admin API\" and the \"Google Analytics Data API\":",
  "     https://console.cloud.google.com/apis/library",
  "  3. Configure the OAuth consent screen: choose External, then PUBLISH the app to Production",
  "     (consent screen → \"Publish app\"). Apps left in \"Testing\" issue refresh tokens that EXPIRE",
  "     after 7 days, so publishing keeps your connection from dying weekly. You can self-approve",
  "     your own app — no Google verification is needed for your own use.",
  "  4. Create credentials → OAuth client ID → application type \"Desktop app\":",
  "     https://console.cloud.google.com/apis/credentials",
  "  5. Paste the client ID and secret here.",
  ""
].join("\n");

const BYO_FALLBACK_NOTE =
  "Couldn't validate the OAuth client details. Continuing without OAuth — you can still install the GA4 tag manually and re-run `infinite setup` later.\n";

const BYO_SKIP_NOTE = "No problem — continuing with browser-based setup.\n";

/**
 * Resolves the GA4 OAuth client config used to start the consent flow.
 *
 * Resolution order (pinned by tests — do not reorder):
 * 1. Explicit env vars (GROWTH_OS_GA4_OAUTH_CLIENT_ID/SECRET) beat everything — no prompts.
 * 2. Embedded release client + non-interactive → use it silently.
 * 3. Embedded release client + interactive → chooser: quick connect (default) or bring-your-own.
 * 4. No client + non-interactive → null (never blocks --json/headless runs on stdin).
 * 5. No client + interactive → guided bring-your-own walkthrough.
 */
export async function prepareGa4ConnectConfig(
  options: PrepareGa4ConnectConfigOptions
): Promise<Ga4ConnectConfig | null> {
  const { env, io } = options;
  const envOverride = Boolean(
    env.GROWTH_OS_GA4_OAUTH_CLIENT_ID?.trim() && env.GROWTH_OS_GA4_OAUTH_CLIENT_SECRET?.trim()
  );
  const embedded = resolveEmbeddedGa4OAuthClient({
    env,
    readReleaseConfig: options.readReleaseConfig
  });

  if (embedded !== null && (envOverride || !options.interactive)) {
    // Env-provided clients are the self-hoster's own app; the release client is Infinite's.
    return useEmbeddedClient(embedded, options, envOverride ? OWN_APP_DISCLOSURE : QUICK_CONNECT_DISCLOSURE);
  }

  if (embedded !== null) {
    const choice = await io.promptChoice(
      GA4_CONNECT_CHOOSER_QUESTION,
      [GA4_QUICK_CONNECT_CHOICE, GA4_BYO_APP_CHOICE],
      0
    );
    if (choice !== 1) {
      return useEmbeddedClient(embedded, options, QUICK_CONNECT_DISCLOSURE);
    }
    return runGuidedByoFlow(options);
  }

  if (!options.interactive) {
    // No embedded client and no interactive terminal to collect a self-hoster
    // OAuth client id/secret → return null instead of blocking on a stdin prompt.
    return null;
  }
  return runGuidedByoFlow(options);
}

function useEmbeddedClient(
  embedded: EmbeddedGa4OAuthClient,
  options: PrepareGa4ConnectConfigOptions,
  disclosure: string
): Ga4ConnectConfig {
  options.io.write(disclosure);
  return {
    clientId: embedded.clientId,
    clientSecret: embedded.clientSecret,
    redirectUri: options.env.GROWTH_OS_GA4_OAUTH_REDIRECT_URI ?? options.defaultRedirectUri
  };
}

async function runGuidedByoFlow(
  options: PrepareGa4ConnectConfigOptions
): Promise<Ga4ConnectConfig | null> {
  const { env, io } = options;
  io.write(BYO_WALKTHROUGH);

  let clientId: string | undefined;
  let clientSecret: string | undefined;
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    clientId = (
      await io.promptText("Google OAuth client ID: ", env.GROWTH_OS_GA4_OAUTH_CLIENT_ID)
    )?.trim();
    if (!clientId) {
      // Enter on the client-ID prompt is an intentional skip, not a validation
      // failure — fall back to browser-based setup with a friendly note.
      io.write(BYO_SKIP_NOTE);
      return null;
    }
    clientSecret = (
      await io.promptSecret("Google OAuth client secret: ", env.GROWTH_OS_GA4_OAUTH_CLIENT_SECRET)
    )?.trim();

    const problems: string[] = [];
    if (!clientId.endsWith(".apps.googleusercontent.com")) {
      problems.push(
        "That doesn't look like a Google OAuth client ID — it should end with .apps.googleusercontent.com (a G-… Measurement ID goes elsewhere)."
      );
    }
    if (!clientSecret) {
      problems.push("The client secret is empty.");
    }

    if (problems.length === 0) {
      break;
    }
    if (attempt === maxAttempts) {
      io.write(BYO_FALLBACK_NOTE);
      return null;
    }
    io.write(`${problems.join("\n")}\nLet's try once more (step 4 of the walkthrough has the right values).\n`);
  }

  if (!clientId || !clientSecret) {
    io.write(BYO_FALLBACK_NOTE);
    return null;
  }
  if (!clientSecret.startsWith("GOCSPX-")) {
    io.write(
      "Note: Google client secrets usually start with GOCSPX- — double-check the value if the connection fails.\n"
    );
  }

  const redirectUri = await io.promptText(
    "Google OAuth redirect URI (press Enter to keep default): ",
    env.GROWTH_OS_GA4_OAUTH_REDIRECT_URI ?? options.defaultRedirectUri
  );
  if (!redirectUri) {
    return null;
  }
  io.write(OWN_APP_DISCLOSURE);
  return { clientId, clientSecret, redirectUri };
}
