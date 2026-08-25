/**
 * Same-machine install handoff: at the end of `infinite setup`, Infinite saves the
 * captured PUBLIC install artifacts (Infinite site source, GA4 measurement id,
 * PostHog project key/api host, X pixel + event tag ids) to
 * `~/.infinite/artifacts/<workspaceId>.json` so a bare
 * `npx infinite-tag install` run on this machine can discover them without pasting flags.
 * `INFINITE_ARTIFACTS_DIR` overrides the directory (tests, sandboxes).
 *
 * SECURITY: the payload is built field-by-field through an explicit whitelist — the
 * input object is never spread or serialized directly — so credential-shaped fields
 * that might ride along on resolved artifacts can never reach disk.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { InfinitePublicArtifact, WorkspaceInstallArtifacts } from "infinite-tag";

import type { InstallCommandArtifacts } from "./install-command.js";

/** Default PostHog ingest host when a captured PostHog artifact has no host of its own. */
export const DEFAULT_POSTHOG_API_HOST = "https://us.i.posthog.com";

/** The setup-owned shape; valid provider objects from other writers are preserved on disk. */
export interface SetupArtifactsFilePayload {
  workspaceId: string;
  productionHosts?: string[];
  infinite?: InfinitePublicArtifact;
  ga4?: { measurementId: string };
  posthog?: { projectKey: string; apiHost?: string };
  x?: { pixelId: string; eventTagIds: string[] };
}

export function defaultSetupArtifactsDir(): string {
  const override = process.env.INFINITE_ARTIFACTS_DIR?.trim();
  return override ? override : join(homedir(), ".infinite", "artifacts");
}

/**
 * Whitelist serializer. Provider rules mirror buildInstrumentInstallCommand: PostHog
 * needs the public project key before an api host matters, X event tags are unusable
 * without a pixel id, and the X event tag Record collapses to deduped values.
 * Returns null when nothing installable was captured.
 */
export function buildSetupArtifactsFilePayload(
  workspaceId: string,
  artifacts: InstallCommandArtifacts | null | undefined
): SetupArtifactsFilePayload | null {
  const payload: SetupArtifactsFilePayload = { workspaceId };
  let installable = false;

  const siteSourceKey = cleanValue(artifacts?.infinite?.siteSourceKey);
  const collectPath = cleanValue(artifacts?.infinite?.collectPath);
  const productionHosts = (artifacts?.productionHosts ?? artifacts?.infinite?.productionHosts ?? [])
    .map((host) => cleanValue(host))
    .filter((host): host is string => host !== null);
  if (siteSourceKey && collectPath && productionHosts.length > 0) {
    payload.infinite = {
      siteSourceKey,
      collectPath,
      productionHosts: [...new Set(productionHosts)],
      ...(artifacts?.infinite?.staticProxy === "vercel" ? { staticProxy: "vercel" as const } : {}),
      ...(artifacts?.infinite?.consentMode === "not_required"
        ? { consentMode: "not_required" as const }
        : {}),
      ...(artifacts?.infinite?.consentMode === "required" ? { consentMode: "required" as const } : {})
    };
    installable = true;
  } else if (artifacts?.productionHosts && productionHosts.length > 0) {
    payload.productionHosts = [...new Set(productionHosts)];
  }

  const measurementId = cleanValue(artifacts?.ga4?.measurementId);
  if (measurementId) {
    payload.ga4 = { measurementId };
    installable = true;
  }

  const projectKey = cleanValue(artifacts?.posthog?.projectKey);
  if (projectKey) {
    payload.posthog = { projectKey };
    const apiHost = cleanValue(artifacts?.posthog?.apiHost);
    if (apiHost) {
      payload.posthog.apiHost = apiHost;
    }
    installable = true;
  }

  const pixelId = cleanValue(artifacts?.x?.pixelId);
  if (pixelId) {
    const tagIds = Object.values(artifacts?.x?.eventTagIds ?? {})
      .map((id) => cleanValue(id))
      .filter((id): id is string => id !== null);
    payload.x = { pixelId, eventTagIds: [...new Set(tagIds)] };
    installable = true;
  }

  return installable ? payload : null;
}

/**
 * Maps the captured PUBLIC artifacts into the installer's {@link WorkspaceInstallArtifacts}
 * map for the auto-install lane. REUSES {@link buildSetupArtifactsFilePayload} so the
 * provider whitelist + X event-tag dedup + "PostHog needs a project key first" rules never
 * drift from the same-machine handoff file. The only extra step: `infinite-tag` requires a
 * concrete `apiHost: string`, so a captured PostHog with no host defaults to
 * {@link DEFAULT_POSTHOG_API_HOST} (the founder can re-run with `--posthog-api-host`).
 * Returns null when nothing installable was captured.
 */
export function buildWorkspaceArtifactsFromResolved(
  workspaceId: string,
  artifacts: InstallCommandArtifacts | null | undefined
): WorkspaceInstallArtifacts | null {
  const payload = buildSetupArtifactsFilePayload(workspaceId, artifacts);
  if (!payload) {
    return null;
  }
  const out: WorkspaceInstallArtifacts = {};
  if (payload.productionHosts) {
    out.productionHosts = payload.productionHosts;
  }
  if (payload.infinite) {
    out.infinite = payload.infinite;
  }
  if (payload.ga4) {
    out.ga4 = { measurementId: payload.ga4.measurementId };
  }
  if (payload.posthog) {
    out.posthog = {
      projectKey: payload.posthog.projectKey,
      apiHost: payload.posthog.apiHost ?? DEFAULT_POSTHOG_API_HOST
    };
  }
  if (payload.x) {
    out.x = { pixelId: payload.x.pixelId, eventTagIds: payload.x.eventTagIds };
  }
  return out;
}

/**
 * Merges the public handoff file (0600, directory 0700) and returns its absolute path.
 * Setup owns productionHosts/ga4/posthog/x. Other provider objects are preserved, and
 * Infinite is replaced only when this setup run supplied a whitelisted Infinite artifact.
 * The final rename is atomic because the temporary file is created in the same directory.
 * Returns null when there is nothing installable to save or the workspace id is not a
 * safe file stem. Filesystem failures throw — callers treat them as non-fatal.
 */
export function writeSetupArtifactsFile(input: {
  workspaceId: string;
  artifacts: InstallCommandArtifacts | null | undefined;
  dir?: string;
}): string | null {
  if (!isSafeArtifactsFileStem(input.workspaceId)) {
    return null;
  }
  const payload = buildSetupArtifactsFilePayload(input.workspaceId, input.artifacts);
  if (!payload) {
    return null;
  }

  const dir = input.dir ?? defaultSetupArtifactsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, `${input.workspaceId}.json`);
  const existing = readExistingArtifactsFile(filePath, input.workspaceId);
  const merged: Record<string, unknown> = { ...existing };
  for (const key of ["productionHosts", "ga4", "posthog", "x"]) {
    delete merged[key];
  }
  if (payload.infinite) {
    delete merged.infinite;
  }
  Object.assign(merged, payload);

  const tempPath = join(dir, `.${input.workspaceId}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, filePath);
  } catch (error) {
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
    throw error;
  }
  return filePath;
}

function readExistingArtifactsFile(filePath: string, workspaceId: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Refusing to overwrite existing artifact file ${filePath}: invalid JSON (${
        error instanceof Error ? error.message : String(error)
      }).`
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`Refusing to overwrite existing artifact file ${filePath}: expected a JSON object.`);
  }
  if (parsed.workspaceId !== undefined && parsed.workspaceId !== workspaceId) {
    throw new Error(
      `Refusing to overwrite existing artifact file ${filePath}: workspaceId does not match ${workspaceId}.`
    );
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "workspaceId") {
      if (typeof value !== "string") {
        throw new Error(
          `Refusing to overwrite existing artifact file ${filePath}: workspaceId must be a string.`
        );
      }
      continue;
    }
    if (key === "productionHosts") {
      if (!Array.isArray(value) || !value.every((host) => typeof host === "string")) {
        throw new Error(
          `Refusing to overwrite existing artifact file ${filePath}: productionHosts must be a string array.`
        );
      }
      continue;
    }
    if (!isRecord(value)) {
      throw new Error(
        `Refusing to overwrite existing artifact file ${filePath}: provider ${key} must be a JSON object.`
      );
    }
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isSafeArtifactsFileStem(workspaceId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workspaceId);
}
