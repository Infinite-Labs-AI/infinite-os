import { describe, expect, it } from "vitest";
import {
  prepareGa4ConnectConfig,
  type Ga4ConnectConfigIo,
  type PrepareGa4ConnectConfigOptions
} from "./ga4-connect-config.js";

interface FakeIo extends Ga4ConnectConfigIo {
  writes: string[];
  textQuestions: string[];
  secretQuestions: string[];
  choiceCalls: Array<{ question: string; choices: string[]; defaultIndex: number }>;
}

function createFakeIo(options: {
  /** Raw answers per text prompt, in order. Empty string simulates pressing Enter (falls back). */
  textAnswers?: string[];
  /** Raw answers per secret prompt, in order. Empty string simulates pressing Enter (falls back). */
  secretAnswers?: string[];
  /** Index returned by the chooser. */
  choiceAnswer?: number;
} = {}): FakeIo {
  const textAnswers = [...(options.textAnswers ?? [])];
  const secretAnswers = [...(options.secretAnswers ?? [])];
  const io: FakeIo = {
    writes: [],
    textQuestions: [],
    secretQuestions: [],
    choiceCalls: [],
    write(message) {
      io.writes.push(message);
    },
    // Mirrors promptFreeformValue semantics: trimmed answer || fallback || undefined.
    async promptText(question, fallback) {
      io.textQuestions.push(question);
      const answer = (textAnswers.shift() ?? "").trim();
      return answer || fallback || undefined;
    },
    async promptSecret(question, fallback) {
      io.secretQuestions.push(question);
      const answer = (secretAnswers.shift() ?? "").trim();
      return answer || fallback || undefined;
    },
    async promptChoice(question, choices, defaultIndex) {
      io.choiceCalls.push({ question, choices, defaultIndex });
      return options.choiceAnswer ?? defaultIndex;
    }
  };
  return io;
}

function baseOptions(io: FakeIo, overrides: Partial<PrepareGa4ConnectConfigOptions> = {}): PrepareGa4ConnectConfigOptions {
  return {
    env: {},
    interactive: true,
    defaultRedirectUri: "http://127.0.0.1:3000/oauth/callback/google_analytics_4",
    readReleaseConfig: () => null,
    io,
    ...overrides
  };
}

const VALID_CLIENT_ID = "1234567890-abc.apps.googleusercontent.com";
const VALID_SECRET = "GOCSPX-secret-value";

describe("prepareGa4ConnectConfig", () => {
  it("env vars beat everything: returns the env client without chooser or prompts, even when interactive", async () => {
    const io = createFakeIo();
    const config = await prepareGa4ConnectConfig(
      baseOptions(io, {
        env: {
          GROWTH_OS_GA4_OAUTH_CLIENT_ID: "env-id",
          GROWTH_OS_GA4_OAUTH_CLIENT_SECRET: "env-secret"
        },
        readReleaseConfig: () => ({ clientId: "rel-id", clientSecret: "rel-secret" })
      })
    );
    expect(config).toMatchObject({ clientId: "env-id", clientSecret: "env-secret" });
    expect(io.choiceCalls).toHaveLength(0);
    expect(io.textQuestions).toHaveLength(0);
    expect(io.secretQuestions).toHaveLength(0);
  });

  it("returns the embedded release client silently when non-interactive (headless/--json path)", async () => {
    const io = createFakeIo();
    const config = await prepareGa4ConnectConfig(
      baseOptions(io, {
        interactive: false,
        readReleaseConfig: () => ({ clientId: "rel-id", clientSecret: "rel-secret" })
      })
    );
    expect(config).toMatchObject({ clientId: "rel-id", clientSecret: "rel-secret" });
    expect(io.choiceCalls).toHaveLength(0);
    expect(io.textQuestions).toHaveLength(0);
  });

  it("returns null when no client is available and non-interactive (never blocks on prompts)", async () => {
    const io = createFakeIo();
    const config = await prepareGa4ConnectConfig(baseOptions(io, { interactive: false }));
    expect(config).toBeNull();
    expect(io.choiceCalls).toHaveLength(0);
    expect(io.textQuestions).toHaveLength(0);
    expect(io.secretQuestions).toHaveLength(0);
  });

  it("attributes the unverified-app screen to Infinite's app on the quick-connect path", async () => {
    const io = createFakeIo();
    await prepareGa4ConnectConfig(
      baseOptions(io, {
        interactive: false,
        readReleaseConfig: () => ({ clientId: "rel-id", clientSecret: "rel-secret" })
      })
    );
    const combined = io.writes.join("");
    expect(combined).toContain("Advanced");
    expect(combined).toContain("hasn't verified");
    expect(combined).toContain("Infinite's app");
    expect(combined).toContain("sign in with Google");
    // Discloses the shared client (shared quota) and points to BYO for full isolation.
    expect(combined).toContain("shared Google app");
    expect(combined).toContain("shared API quota");
    expect(combined).toContain("full isolation");
    // Quick connect uses Infinite's Google app — "your own app" would be false here.
    expect(combined).not.toContain("your own app");
  });

  it("keeps the own-app disclosure when the client comes from env vars (self-hoster's own app)", async () => {
    const io = createFakeIo();
    await prepareGa4ConnectConfig(
      baseOptions(io, {
        env: {
          GROWTH_OS_GA4_OAUTH_CLIENT_ID: "env-id",
          GROWTH_OS_GA4_OAUTH_CLIENT_SECRET: "env-secret"
        }
      })
    );
    const combined = io.writes.join("");
    expect(combined).toContain("your own unverified app");
    expect(combined).not.toContain("Infinite's app");
  });

  it("applies the GROWTH_OS_GA4_OAUTH_REDIRECT_URI override on the quick-connect path", async () => {
    const io = createFakeIo();
    const config = await prepareGa4ConnectConfig(
      baseOptions(io, {
        interactive: false,
        env: { GROWTH_OS_GA4_OAUTH_REDIRECT_URI: "http://localhost:9999/cb" },
        readReleaseConfig: () => ({ clientId: "rel-id", clientSecret: "rel-secret" })
      })
    );
    expect(config?.redirectUri).toBe("http://localhost:9999/cb");
  });

  describe("interactive chooser (embedded client present)", () => {
    it("offers both options with quick connect as the default; Enter selects quick connect", async () => {
      const io = createFakeIo();
      const config = await prepareGa4ConnectConfig(
        baseOptions(io, {
          readReleaseConfig: () => ({ clientId: "rel-id", clientSecret: "rel-secret" })
        })
      );
      expect(io.choiceCalls).toHaveLength(1);
      const call = io.choiceCalls[0]!;
      expect(call.defaultIndex).toBe(0);
      expect(call.choices).toHaveLength(2);
      expect(call.choices[0]).toContain("Quick connect with Infinite's Google app");
      expect(call.choices[0]).toContain("~1 min");
      expect(call.choices[0]).toContain("recommended");
      expect(call.choices[1]).toContain("Use your own Google Cloud app");
      expect(call.choices[1]).toContain("~5 min");
      expect(config).toMatchObject({ clientId: "rel-id", clientSecret: "rel-secret" });
      expect(io.textQuestions).toHaveLength(0);
    });

    it("routes option 2 to the guided bring-your-own flow", async () => {
      const io = createFakeIo({
        choiceAnswer: 1,
        textAnswers: [VALID_CLIENT_ID, ""],
        secretAnswers: [VALID_SECRET]
      });
      const config = await prepareGa4ConnectConfig(
        baseOptions(io, {
          readReleaseConfig: () => ({ clientId: "rel-id", clientSecret: "rel-secret" })
        })
      );
      expect(config).toMatchObject({ clientId: VALID_CLIENT_ID, clientSecret: VALID_SECRET });
      const combined = io.writes.join("");
      expect(combined).toContain("https://console.cloud.google.com/projectcreate");
    });

    it("attributes the unverified-app screen to the founder's own app on the BYO path", async () => {
      const io = createFakeIo({
        choiceAnswer: 1,
        textAnswers: [VALID_CLIENT_ID, ""],
        secretAnswers: [VALID_SECRET]
      });
      await prepareGa4ConnectConfig(
        baseOptions(io, {
          readReleaseConfig: () => ({ clientId: "rel-id", clientSecret: "rel-secret" })
        })
      );
      const combined = io.writes.join("");
      expect(combined).toContain("hasn't verified");
      expect(combined).toContain("Advanced");
      expect(combined).toContain("your own unverified app");
      expect(combined).not.toContain("Infinite's app");
    });
  });

  describe("guided bring-your-own flow", () => {
    it("skips the chooser entirely when no embedded client exists (no dead chooser)", async () => {
      const io = createFakeIo({
        textAnswers: [VALID_CLIENT_ID, ""],
        secretAnswers: [VALID_SECRET]
      });
      const config = await prepareGa4ConnectConfig(baseOptions(io));
      expect(io.choiceCalls).toHaveLength(0);
      expect(config).toMatchObject({ clientId: VALID_CLIENT_ID, clientSecret: VALID_SECRET });
    });

    it("prints the numbered walkthrough before prompting", async () => {
      const io = createFakeIo({
        textAnswers: [VALID_CLIENT_ID, ""],
        secretAnswers: [VALID_SECRET]
      });
      await prepareGa4ConnectConfig(baseOptions(io));
      const combined = io.writes.join("");
      expect(combined).toContain("https://console.cloud.google.com/projectcreate");
      expect(combined).toContain("Google Analytics Admin API");
      expect(combined).toContain("Google Analytics Data API");
      expect(combined).toContain("https://console.cloud.google.com/apis/library");
      expect(combined).toContain("External");
      // The walkthrough must steer founders to PUBLISH (not stay in "Testing"),
      // otherwise their refresh token expires after 7 days.
      expect(combined).toContain("Publish app");
      expect(combined).toContain("7 days");
      expect(combined).toContain("Desktop app");
      expect(combined).toContain("https://console.cloud.google.com/apis/credentials");
      // Walkthrough must appear before the first prompt was asked.
      expect(io.textQuestions.length).toBeGreaterThan(0);
    });

    it("uses the default redirect URI when the founder presses Enter", async () => {
      const io = createFakeIo({
        textAnswers: [VALID_CLIENT_ID, ""],
        secretAnswers: [VALID_SECRET]
      });
      const config = await prepareGa4ConnectConfig(baseOptions(io));
      expect(config?.redirectUri).toBe("http://127.0.0.1:3000/oauth/callback/google_analytics_4");
    });

    it("re-prompts once when the client ID is not a Google OAuth client ID (e.g. a G- measurement ID)", async () => {
      const io = createFakeIo({
        textAnswers: ["G-ABC123", VALID_CLIENT_ID, ""],
        secretAnswers: [VALID_SECRET, VALID_SECRET]
      });
      const config = await prepareGa4ConnectConfig(baseOptions(io));
      expect(config).toMatchObject({ clientId: VALID_CLIENT_ID, clientSecret: VALID_SECRET });
      const combined = io.writes.join("");
      expect(combined).toContain(".apps.googleusercontent.com");
    });

    it("falls back to null (manual-tag path) after two invalid attempts", async () => {
      const io = createFakeIo({
        textAnswers: ["not-a-client-id", "still-wrong"],
        secretAnswers: [VALID_SECRET, VALID_SECRET]
      });
      const config = await prepareGa4ConnectConfig(baseOptions(io));
      expect(config).toBeNull();
    });

    it("treats Enter on the client-ID prompt as a friendly skip to browser-based setup", async () => {
      const io = createFakeIo({
        textAnswers: [""],
        secretAnswers: [VALID_SECRET]
      });
      const config = await prepareGa4ConnectConfig(baseOptions(io));
      expect(config).toBeNull();
      // Skips immediately — never asks for the secret.
      expect(io.secretQuestions).toHaveLength(0);
      const combined = io.writes.join("");
      expect(combined).toContain("No problem — continuing with browser-based setup.");
      // No failure-toned validation note for an intentional skip.
      expect(combined).not.toContain("Couldn't validate");
    });

    it("also skips on Enter at the retry client-ID prompt after one invalid attempt", async () => {
      const io = createFakeIo({
        textAnswers: ["not-a-client-id", ""],
        secretAnswers: [VALID_SECRET]
      });
      const config = await prepareGa4ConnectConfig(baseOptions(io));
      expect(config).toBeNull();
      expect(io.writes.join("")).toContain("No problem — continuing with browser-based setup.");
    });

    it("warns but does not block when the secret lacks the GOCSPX- prefix", async () => {
      const io = createFakeIo({
        textAnswers: [VALID_CLIENT_ID, ""],
        secretAnswers: ["legacy-secret-format"]
      });
      const config = await prepareGa4ConnectConfig(baseOptions(io));
      expect(config).toMatchObject({ clientId: VALID_CLIENT_ID, clientSecret: "legacy-secret-format" });
      const combined = io.writes.join("");
      expect(combined).toContain("GOCSPX-");
    });

    it("re-prompts once when the secret is empty but the ID is valid", async () => {
      const io = createFakeIo({
        textAnswers: [VALID_CLIENT_ID, VALID_CLIENT_ID, ""],
        secretAnswers: ["", VALID_SECRET]
      });
      const config = await prepareGa4ConnectConfig(baseOptions(io));
      expect(config).toMatchObject({ clientId: VALID_CLIENT_ID, clientSecret: VALID_SECRET });
    });
  });
});
