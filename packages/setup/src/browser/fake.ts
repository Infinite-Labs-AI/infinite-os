import {
  assertNoEvasion,
  type BrowserRequestOptions,
  type BrowserResponse,
  type BrowserLaunchOptions,
  type LocalBrowser,
  type LocalBrowserFactory
} from "./types.js";

export interface FakeBrowserScript {
  loginSignalUrl?: string;
  network?: Array<{ url: string; status: number }>;
  request?: (url: string, init?: BrowserRequestOptions) => Promise<BrowserResponse>;
}

export interface FakeBrowserFactory extends LocalBrowserFactory {
  destroyed: boolean;
  visited: string[];
}

export function createFakeBrowserFactory(script: FakeBrowserScript = {}): FakeBrowserFactory {
  const state = { destroyed: false, visited: [] as string[] };
  const factory: FakeBrowserFactory = {
    get destroyed() {
      return state.destroyed;
    },
    get visited() {
      return state.visited;
    },
    async create(opts: BrowserLaunchOptions): Promise<LocalBrowser> {
      assertNoEvasion(opts);
      return {
        async goto(url) {
          state.visited.push(url);
        },
        async waitForSignal(predicate) {
          if (script.loginSignalUrl && predicate(script.loginSignalUrl)) {
            return { url: script.loginSignalUrl };
          }
          return null; // simulates a timeout with no matching navigation
        },
        async readNetwork() {
          return script.network ?? [];
        },
        async request(url, init) {
          if (script.request) {
            return script.request(url, init);
          }
          return {
            ok: false,
            status: 404,
            async json() {
              return { error: "not scripted" };
            },
            async text() {
              return JSON.stringify({ error: "not scripted" });
            }
          };
        },
        async destroy() {
          state.destroyed = true;
        }
      };
    }
  };
  return factory;
}
