/**
 * The founder-facing `npx infinite-tag install …` command, built from the PUBLIC
 * artifacts captured during `infinite setup`. Infinite runs on the founder's
 * desktop where cwd is NOT their website's repo, so a copy-paste command they run
 * inside that repo is the primary install handoff. Public artifacts only
 * (measurement id / project key / pixel id) — secrets never enter this string.
 */

/**
 * Loose structural shape so callers can pass either the cross-provider
 * `SetupResolvedArtifacts` (packages/db) or a single provider's
 * `SetupProviderPublicArtifacts` slice.
 */
export interface InstallCommandArtifacts {
  ga4?: { measurementId?: string | null; propertyId?: string | null } | null;
  posthog?: { projectId?: string | null; projectKey?: string | null; apiHost?: string | null } | null;
  x?: { pixelId?: string | null; eventTagIds?: Record<string, string> | null } | null;
}

/**
 * Returns the complete install command, or null when no installable artifact was
 * captured (an artifact-less `install --workspace … --yes` would have nothing to do).
 * Provider rules mirror the installer's own validation: PostHog needs the project
 * key before an api host matters, and X event tags are unusable without a pixel id.
 */
export function buildInstrumentInstallCommand(input: {
  workspaceId: string;
  artifacts: InstallCommandArtifacts | null | undefined;
}): string | null {
  const flags: string[] = [];

  const measurementId = cleanValue(input.artifacts?.ga4?.measurementId);
  if (measurementId) {
    flags.push(`--ga4-measurement-id ${quoteForShell(measurementId)}`);
  }

  const projectKey = cleanValue(input.artifacts?.posthog?.projectKey);
  if (projectKey) {
    flags.push(`--posthog-project-key ${quoteForShell(projectKey)}`);
    const apiHost = cleanValue(input.artifacts?.posthog?.apiHost);
    if (apiHost) {
      flags.push(`--posthog-api-host ${quoteForShell(apiHost)}`);
    }
  }

  const pixelId = cleanValue(input.artifacts?.x?.pixelId);
  if (pixelId) {
    flags.push(`--x-pixel-id ${quoteForShell(pixelId)}`);
    const tagIds = Object.values(input.artifacts?.x?.eventTagIds ?? {})
      .map((id) => cleanValue(id))
      .filter((id): id is string => id !== null);
    for (const tagId of [...new Set(tagIds)]) {
      flags.push(`--x-event-tag-id ${quoteForShell(tagId)}`);
    }
  }

  if (flags.length === 0) {
    return null;
  }

  return `npx infinite-tag install --workspace ${quoteForShell(input.workspaceId)} ${flags.join(" ")} --yes`;
}

function cleanValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** POSIX single-quote escaping; plain values pass through untouched so the command stays readable. */
function quoteForShell(value: string): string {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
