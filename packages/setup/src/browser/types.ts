export type BrowserPurpose = "provider_auth" | "verify";

export interface BrowserLaunchOptions {
  provider: string;
  purpose: BrowserPurpose;
  contextRef?: string; // local persistent-profile name (never a secret blob)
  sessionKey?: string; // scoped persistence key for resumable browser state
  // ToS-safe (v6 §7.4): these MUST be false/undefined for provider_auth.
  solveCaptchas?: boolean;
  proxy?: boolean;
  stealth?: boolean;
}

export interface BrowserRequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

export interface BrowserResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface LocalBrowser {
  goto(url: string): Promise<void>;
  /** Resolve when `predicate(currentUrl)` is true (post-login/redirect), or null on timeout. */
  waitForSignal(predicate: (url: string) => boolean, timeoutMs: number): Promise<{ url: string } | null>;
  readNetwork(): Promise<Array<{ url: string; status: number }>>;
  /** Run a page-context fetch that reuses the authenticated browser session/cookies. */
  request(url: string, init?: BrowserRequestOptions): Promise<BrowserResponse>;
  destroy(): Promise<void>;
}

export interface LocalBrowserFactory {
  create(opts: BrowserLaunchOptions): Promise<LocalBrowser>;
}

/** Shared guard used by every factory impl (fake + real Playwright). */
export function assertNoEvasion(opts: BrowserLaunchOptions): void {
  if (opts.purpose === "provider_auth" && (opts.solveCaptchas || opts.proxy || opts.stealth)) {
    throw new Error(
      "provider_auth browser sessions must not enable CAPTCHA-solving, proxies, or stealth (ToS-safe, v6 §7.4)"
    );
  }
}
