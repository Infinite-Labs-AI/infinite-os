/**
 * The bridge transport for `infinite contacts sync` — the CLI side of the
 * desktop's `contacts.import.v1` verb.
 *
 * The wire is PINNED by the desktop (1bu-1
 * apps/desktop/src/main/brain/agent/contacts-import-bridge.ts — its decode
 * function IS the contract): POST {bridgeUrl}/v1/contacts/import with the
 * descriptor's bearer token and a body of
 *   { protocolVersion: 1, requestId?, mode: "dry_run" | "commit",
 *     workspacePin? (REQUIRED for commit — the opaque pin from the dry-run
 *     response, never a raw engine project id), provenance, mapping, rows }.
 *
 * Discovery/auth are the EXISTING client's (`resolveLiveBridge` /
 * `readDesktopBridgeDescriptor` in ../desktop-app-client.ts); this module only
 * carries the one route that client does not, with a longer deadline — a 25k
 * row import is minutes of cloud work, not the 15s of a status ping.
 */
import { ContactsSyncError } from "./sync-error.js";

export const CONTACTS_IMPORT_CAPABILITY = "contacts.import.v1";

const DEFAULT_IMPORT_TIMEOUT_MS = 10 * 60_000;

export type ContactsImportMode = "dry_run" | "commit";

export interface ContactsImportRequest {
  mode: ContactsImportMode;
  /** Required for commit: the opaque pin returned by the dry-run response. */
  workspacePin?: string;
  provenance: string;
  mapping: Record<string, string>;
  rows: Array<Record<string, string>>;
  requestId?: string;
}

export interface BridgeImportResult {
  status: number;
  body: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PostContactsImportOptions {
  bridgeUrl: string;
  /** The descriptor's bearer token — bridge auth, never printed. */
  token: string;
  request: ContactsImportRequest;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** POST /v1/contacts/import. Non-2xx statuses are RETURNED (typed handling lives with the caller); only transport failure throws. */
export async function postContactsImport(
  options: PostContactsImportOptions
): Promise<BridgeImportResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { request } = options;
  let response: Response;
  try {
    response = await fetchImpl(`${options.bridgeUrl}/v1/contacts/import`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        protocolVersion: 1,
        ...(request.requestId ? { requestId: request.requestId } : {}),
        mode: request.mode,
        ...(request.workspacePin ? { workspacePin: request.workspacePin } : {}),
        provenance: request.provenance,
        mapping: request.mapping,
        rows: request.rows
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS)
    });
  } catch {
    throw new ContactsSyncError(
      "desktop_unreachable",
      "The Infinite app stopped responding mid-import. Make sure it is still open, then re-run — re-imports merge safely."
    );
  }
  let body: Record<string, unknown> = {};
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload)) body = payload;
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

/**
 * Error code extraction across the THREE body shapes the route can answer
 * with: bridge protocol faults (`error: { code, message }`), bridge service
 * refusals (`error: "no_linked_workspace", message`), and forwarded cloud
 * errors (`ok: false, error: { code, message }`).
 */
export function importErrorCode(body: Record<string, unknown>): string | undefined {
  const error = body.error;
  if (typeof error === "string" && error) return error;
  if (isRecord(error) && typeof error.code === "string" && error.code) return error.code;
  return undefined;
}

export function importErrorMessage(body: Record<string, unknown>): string | undefined {
  if (typeof body.message === "string" && body.message) return body.message;
  const error = body.error;
  if (isRecord(error) && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return undefined;
}

/**
 * The failure-modes table, by exact status + code (design doc + the Phase 1
 * wire). Every line is terminal-safe: the bridge sanitizes its output, and
 * nothing here interpolates row content or credentials.
 */
export function describeImportFailure(status: number, body: Record<string, unknown>): string {
  const code = importErrorCode(body);
  const message = importErrorMessage(body);

  if (status === 401) {
    return "The Infinite app rejected this terminal's bridge credentials. Restart the Infinite app, then re-run.";
  }
  if (status === 409 && code === "workspace_changed") {
    return (
      (message ??
        "The app's active workspace changed since the dry run.") +
      " Re-run `infinite contacts sync` from the start."
    );
  }
  if (status === 413) {
    return "That request is more than the app bridge can carry in one run. Split by created_at (import your oldest cohort first, then the rest) and re-run.";
  }
  if (status === 503) {
    if (code === "capability_unavailable") {
      return "Update the Infinite app first — this version can't import contacts yet.";
    }
    if (code === "cloud_unavailable") {
      return (
        message ??
        "The Infinite app is signed out or the cloud is unreachable. Open the Infinite app and sign in, then re-run."
      );
    }
    if (code === "no_linked_workspace") {
      return message ?? "The Infinite app has no linked workspace — finish app setup first.";
    }
    if (code === "email_lifecycle_disabled") {
      return "Lifecycle email isn't switched on for this deployment yet.";
    }
    return message ?? "The Infinite app could not serve the import right now. Re-run in a moment.";
  }
  if (status === 502) {
    return (
      message ??
      "The Infinite app could not reach the workspace import service. Check your connection and re-run."
    );
  }
  if (status === 400) {
    return `The app bridge refused the request${message ? `: ${message}` : "."}`;
  }
  return message ?? `The import failed (HTTP ${status}).`;
}
