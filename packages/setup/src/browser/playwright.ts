import { chmod, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  buildBrowserSessionKey,
  createFileBrowserSessionStore,
  type BrowserSessionStore
} from "./session-store.js";
import {
  assertNoEvasion,
  type BrowserLaunchOptions,
  type LocalBrowser,
  type LocalBrowserFactory
} from "./types.js";

export type PlaywrightModuleLoader = () => Promise<unknown>;

export interface PlaywrightBrowserFactoryOptions {
  profileRoot?: string;
  sessionStore?: BrowserSessionStore;
  loadPlaywright?: PlaywrightModuleLoader;
  pollIntervalMs?: number;
  launchOptions?: Record<string, unknown>;
}

interface PlaywrightResponseLike {
  url(): string;
  status(): number;
}

interface PlaywrightPageLike {
  goto(url: string): Promise<unknown>;
  url(): string;
  evaluate?<T>(pageFunction: (arg: unknown) => Promise<T>, arg: unknown): Promise<T>;
  on?(event: "response", handler: (response: PlaywrightResponseLike) => void): void;
}

interface PlaywrightBrowserContextLike {
  pages(): PlaywrightPageLike[];
  newPage(): Promise<PlaywrightPageLike>;
  close(): Promise<void>;
}

interface PlaywrightChromiumLike {
  launchPersistentContext(
    userDataDir: string,
    options?: Record<string, unknown>
  ): Promise<PlaywrightBrowserContextLike>;
}

interface PlaywrightModuleLike {
  chromium?: PlaywrightChromiumLike;
}

const DEFAULT_PROFILE_ROOT = join(homedir(), ".growth-os", "browser-profiles");
const DEFAULT_SESSION_STORE = createFileBrowserSessionStore(join(homedir(), ".growth-os", "browser-sessions.json"));
const PLAYWRIGHT_SPECIFIER = "playwright";

export function createPlaywrightBrowserFactory(
  options: PlaywrightBrowserFactoryOptions = {}
): LocalBrowserFactory {
  const loadPlaywright = options.loadPlaywright ?? (() => dynamicImport(PLAYWRIGHT_SPECIFIER));
  const profileRoot = options.profileRoot ?? DEFAULT_PROFILE_ROOT;
  const sessionStore = options.sessionStore ?? DEFAULT_SESSION_STORE;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const launchOptions = options.launchOptions ?? {};

  return {
    async create(opts: BrowserLaunchOptions): Promise<LocalBrowser> {
      assertNoEvasion(opts);

      const sessionKey = opts.sessionKey ?? buildBrowserSessionKey(opts.provider, opts.contextRef);
      const existingRef = await sessionStore.load(sessionKey);
      const profileRef = sanitizeProfileRef(opts.contextRef ?? existingRef?.profileRef ?? opts.provider);
      const profilePath = join(profileRoot, profileRef);
      const resumeNonce = existingRef?.resumeNonce ?? randomUUID();

      await ensurePrivateDir(profileRoot);
      await ensurePrivateDir(profilePath);

      const playwright = await resolvePlaywright(loadPlaywright);
      const context = await playwright.chromium.launchPersistentContext(profilePath, {
        headless: false,
        ...launchOptions
      });
      const page = context.pages()[0] ?? await context.newPage();
      const network: Array<{ url: string; status: number }> = [];

      page.on?.("response", (response) => {
        network.push({ url: response.url(), status: response.status() });
        void persistSession(sessionStore, sessionKey, profileRef, resumeNonce, safeUrl(page));
      });

      await persistSession(sessionStore, sessionKey, profileRef, resumeNonce, safeUrl(page));

      return {
        async goto(url: string) {
          await page.goto(url);
          await persistSession(sessionStore, sessionKey, profileRef, resumeNonce, safeUrl(page));
        },
        async waitForSignal(predicate, timeoutMs) {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() <= deadline) {
            const currentUrl = safeUrl(page);
            if (currentUrl && predicate(currentUrl)) {
              await persistSession(sessionStore, sessionKey, profileRef, resumeNonce, currentUrl);
              return { url: currentUrl };
            }
            await sleep(pollIntervalMs);
          }
          await persistSession(sessionStore, sessionKey, profileRef, resumeNonce, safeUrl(page));
          return null;
        },
        async readNetwork() {
          return [...network];
        },
        async request(url, init) {
          if (typeof page.evaluate !== "function") {
            throw new Error("Authenticated browser requests require page.evaluate()");
          }
          const response = await page.evaluate(async (input) => {
            const request = input as {
              url: string;
              init?: {
                method?: "GET" | "POST";
                headers?: Record<string, string>;
                body?: string;
              };
            };
            const fetched = await fetch(request.url, {
              method: request.init?.method ?? "GET",
              headers: request.init?.headers,
              body: request.init?.body,
              credentials: "include"
            });
            const text = await fetched.text();
            return {
              ok: fetched.ok,
              status: fetched.status,
              text
            };
          }, { url, init });
          await persistSession(sessionStore, sessionKey, profileRef, resumeNonce, safeUrl(page));
          return {
            ok: response.ok,
            status: response.status,
            async json() {
              return response.text.length > 0 ? JSON.parse(response.text) : null;
            },
            async text() {
              return response.text;
            }
          };
        },
        async destroy() {
          await persistSession(sessionStore, sessionKey, profileRef, resumeNonce, safeUrl(page));
          await context.close();
        }
      };
    }
  };
}

async function resolvePlaywright(loadPlaywright: PlaywrightModuleLoader): Promise<Required<PlaywrightModuleLike>> {
  try {
    const loaded = await loadPlaywright();
    const module = loaded as PlaywrightModuleLike;
    if (!module.chromium || typeof module.chromium.launchPersistentContext !== "function") {
      throw new Error("Loaded module does not expose chromium.launchPersistentContext()");
    }
    return { chromium: module.chromium };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      "Playwright browser assist is unavailable. Install it with `pnpm add -D playwright` " +
        "(and `pnpm exec playwright install` if browser binaries are missing), or inject a custom loader in tests. " +
        `Original error: ${message}`
    );
  }
}

async function persistSession(
  sessionStore: BrowserSessionStore,
  sessionKey: string,
  profileRef: string,
  resumeNonce: string,
  lastUrl: string | undefined
): Promise<void> {
  await sessionStore.save(sessionKey, { profileRef, resumeNonce, lastUrl });
}

function sanitizeProfileRef(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-");
  return normalized.replace(/^-+|-+$/g, "") || "setup-browser";
}

function safeUrl(page: PlaywrightPageLike): string | undefined {
  const value = page.url();
  return value && value !== "about:blank" ? value : undefined;
}

async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    await chmod(path, 0o700);
  } catch {
    // Best-effort on non-POSIX filesystems; the directory already exists for use either way.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dynamicImport(specifier: string): Promise<unknown> {
  return new Function("moduleName", "return import(moduleName);")(specifier) as Promise<unknown>;
}
