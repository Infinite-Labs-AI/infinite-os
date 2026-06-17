/**
 * Same-machine install handoff: at the end of `infinite setup`, Infinite saves the
 * captured PUBLIC install artifacts (GA4 measurement id, PostHog project key/api host,
 * X pixel + event tag ids) to `~/.infinite/artifacts/<workspaceId>.json` so a bare
 * `npx infinite-tag install` run on this machine can discover them without pasting flags.
 * `INFINITE_ARTIFACTS_DIR` overrides the directory (tests, sandboxes).
 *
 * SECURITY: the payload is built field-by-field through an explicit whitelist — the
 * input object is never spread or serialized directly — so credential-shaped fields
 * that might ride along on resolved artifacts can never reach disk.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { WorkspaceInstallArtifacts } from "infinite-tag";

import type { InstallCommandArtifacts } from "./install-command.js";

/** Default PostHog ingest host when a captured PostHog artifact has no host of its own. */
export const DEFAULT_POSTHOG_API_HOST = "https://us.i.posthog.com";

/** The exact (and only) shape ever written; matches what `infinite-tag` coerces on read. */
export interface SetupArtifactsFilePayload {
  workspaceId: string;
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
 * Writes the public handoff file (0600, directory 0700) and returns its absolute path.
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
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's mode only applies when the file is created; enforce it on rewrites too.
  chmodSync(filePath, 0o600);
  return filePath;
}

function cleanValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isSafeArtifactsFileStem(workspaceId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workspaceId);
}
