import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SetupResolvedArtifacts } from "@infinite-os/db";

import { writeSetupArtifactsFile } from "./artifacts-file.js";

const tempDirs: string[] = [];
let savedEnvDir: string | undefined;

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "setup-artifacts-file-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  savedEnvDir = process.env.INFINITE_ARTIFACTS_DIR;
  delete process.env.INFINITE_ARTIFACTS_DIR;
});

afterEach(() => {
  if (savedEnvDir === undefined) {
    delete process.env.INFINITE_ARTIFACTS_DIR;
  } else {
    process.env.INFINITE_ARTIFACTS_DIR = savedEnvDir;
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function resolvedArtifacts(overrides: Partial<SetupResolvedArtifacts> = {}): SetupResolvedArtifacts {
  return {
    ga4: { measurementId: null, propertyId: null },
    posthog: { projectId: null, projectKey: null, apiHost: null },
    x: { pixelId: null, eventTagIds: null },
    ...overrides
  };
}

describe("writeSetupArtifactsFile", () => {
  it("writes the whitelisted public payload for every captured provider with 0600 perms", () => {
    const dir = makeTempDir();

    const filePath = writeSetupArtifactsFile({
      workspaceId: "ws_1",
      artifacts: resolvedArtifacts({
        ga4: { measurementId: "G-ACME123", propertyId: "properties/123" },
        posthog: { projectId: "ph_project", projectKey: "phc_public_key", apiHost: "https://us.i.posthog.com" },
        x: { pixelId: "px_123", eventTagIds: { signup: "tw-event-1", trial: "tw-event-1", purchase: "tw-event-2" } }
      }),
      dir
    });

    expect(filePath).toBe(join(dir, "ws_1.json"));
    const written = JSON.parse(readFileSync(filePath!, "utf8"));
    // Exact shape: workspaceId + public fields only. propertyId/projectId never ride along,
    // and the X event tag Record collapses to deduped values for the instrument CLI.
    expect(written).toEqual({
      workspaceId: "ws_1",
      ga4: { measurementId: "G-ACME123" },
      posthog: { projectKey: "phc_public_key", apiHost: "https://us.i.posthog.com" },
      x: { pixelId: "px_123", eventTagIds: ["tw-event-1", "tw-event-2"] }
    });
    expect(statSync(filePath!).mode & 0o777).toBe(0o600);
  });

  it("omits providers with nothing installable (mirrors the install command's rules)", () => {
    const dir = makeTempDir();

    const filePath = writeSetupArtifactsFile({
      workspaceId: "ws_1",
      artifacts: resolvedArtifacts({
        ga4: { measurementId: "G-ACME123", propertyId: null },
        // api host without a project key is not installable
        posthog: { projectId: null, projectKey: null, apiHost: "https://us.i.posthog.com" },
        // event tags without a pixel id are not installable
        x: { pixelId: null, eventTagIds: { signup: "tw-event-1" } }
      }),
      dir
    });

    const written = JSON.parse(readFileSync(filePath!, "utf8"));
    expect(written).toEqual({ workspaceId: "ws_1", ga4: { measurementId: "G-ACME123" } });
  });

  it("returns null and writes nothing when no installable artifact was captured", () => {
    const dir = makeTempDir();

    const filePath = writeSetupArtifactsFile({
      workspaceId: "ws_1",
      artifacts: resolvedArtifacts(),
      dir
    });

    expect(filePath).toBeNull();
    expect(existsSync(join(dir, "ws_1.json"))).toBe(false);
  });

  it("defaults the directory to INFINITE_ARTIFACTS_DIR when no dir is passed", () => {
    const dir = makeTempDir();
    process.env.INFINITE_ARTIFACTS_DIR = dir;

    const filePath = writeSetupArtifactsFile({
      workspaceId: "ws_env",
      artifacts: resolvedArtifacts({ ga4: { measurementId: "G-ENV123", propertyId: null } })
    });

    expect(filePath).toBe(join(dir, "ws_env.json"));
    expect(existsSync(filePath!)).toBe(true);
  });

  it("refuses path-hostile workspace ids instead of writing outside the artifacts dir", () => {
    const dir = makeTempDir();

    for (const hostile of ["../escape", "a/b", "a\\b", ".hidden", ""]) {
      expect(
        writeSetupArtifactsFile({
          workspaceId: hostile,
          artifacts: resolvedArtifacts({ ga4: { measurementId: "G-ACME123", propertyId: null } }),
          dir
        })
      ).toBeNull();
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it("never serializes secret-shaped fields smuggled into the resolved artifacts", () => {
    const dir = makeTempDir();
    // Pollute every level with credential-shaped extras: the writer must whitelist
    // fields explicitly, so none of these can reach disk.
    const polluted = {
      accessToken: "ya29.top-level-access-token",
      oauthTokenId: "oauth_tok_root",
      personalApiKey: "phx_root_personal_key",
      ga4: {
        measurementId: "G-ACME123",
        propertyId: "properties/123",
        accessToken: "ya29.ga4-access-token",
        refreshToken: "1//ga4-refresh-token",
        oauthTokenId: "oauth_tok_ga4",
        clientSecret: "sk-ga4-client-secret"
      },
      posthog: {
        projectId: "ph_project",
        projectKey: "phc_public_key",
        apiHost: "https://us.i.posthog.com",
        personalApiKey: "phx_smuggled_personal_key",
        accessToken: "posthog-access-token",
        secret: "sk-posthog-secret"
      },
      x: {
        pixelId: "px_123",
        eventTagIds: { signup: "tw-event-1" },
        bearerToken: "x-bearer-token",
        apiSecret: "x-api-secret",
        oauthTokenId: "oauth_tok_x"
      }
    } as unknown as SetupResolvedArtifacts;

    const filePath = writeSetupArtifactsFile({ workspaceId: "ws_1", artifacts: polluted, dir });

    const content = readFileSync(filePath!, "utf8");
    expect(content).not.toMatch(/phx_|token|secret|sk-/i);
    expect(JSON.parse(content)).toEqual({
      workspaceId: "ws_1",
      ga4: { measurementId: "G-ACME123" },
      posthog: { projectKey: "phc_public_key", apiHost: "https://us.i.posthog.com" },
      x: { pixelId: "px_123", eventTagIds: ["tw-event-1"] }
    });
  });

  it("propagates filesystem failures to the caller (which treats them as non-fatal)", () => {
    const dir = makeTempDir();
    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "occupied");

    expect(() =>
      writeSetupArtifactsFile({
        workspaceId: "ws_1",
        artifacts: resolvedArtifacts({ ga4: { measurementId: "G-ACME123", propertyId: null } }),
        dir: blocked
      })
    ).toThrow();
  });
});
