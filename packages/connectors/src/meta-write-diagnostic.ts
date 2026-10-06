import { AsyncLocalStorage } from "node:async_hooks";

/** Additive wire contract. Missing fields mean unknown, never inferred HTTP metadata. */
export interface MetaWriteDiagnostic {
  version: 1;
  phase: "not_dispatched" | "provider_response" | "dispatch_unknown";
  outcome: "refused" | "throttled" | "temporary" | "unknown";
  providerCode?: number;
  providerSubcode?: number;
  httpStatus?: number;
  metaMessage?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export function redactMetaDiagnostic(text: string, token?: string): string {
  let safe = token ? text.split(token).join("[REDACTED]") : text;
  if (token) safe = safe.split(encodeURIComponent(token)).join("[REDACTED]");
  return safe.replace(/EAA[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/https?:\/\/[^\s<>"']+/gi, (url) => {
      try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}${parsed.pathname}`; }
      catch { return "[REDACTED_URL]"; }
    })
    .replace(/((?:access[_-]?token|appsecret_proof|authorization)["']?\s*[=:]\s*["']?)[^\s,"'}]+/gi, "$1[REDACTED]");
}

/** Bounds JSON bytes (including escaping), not UTF-16 characters; safe for the host's 8KB column. */
export function boundedMetaDiagnosticText(text: string, bytes: number): string {
  const chars = Array.from(text);
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(JSON.stringify(chars.slice(0, mid).join(""))) <= bytes) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("");
}

export function metaProviderOutcome(code?: number, subcode?: number, status?: number, transient = false): MetaWriteDiagnostic["outcome"] {
  if (status === 429 || subcode === 2446079 || code !== undefined &&
      ([4, 17, 32, 613].includes(code) || code >= 80000 && code <= 80014)) return "throttled";
  if (transient || status !== undefined && status >= 500 || code === 1 || code === 2) return "temporary";
  return code !== undefined && [10, 100, 102, 104, 105, 190, 200, 294].includes(code) ? "refused" : "unknown";
}

export function metaCliDiagnostic(input: {
  stdout: string; stderr: string; exitCode: number | null; signal: string | null;
  durationMs: number; token?: string; notDispatched?: boolean; stdoutTruncated?: boolean; stderrTruncated?: boolean;
}): MetaWriteDiagnostic {
  const stdout = redactMetaDiagnostic(input.stdout, input.token);
  const stderr = redactMetaDiagnostic(input.stderr, input.token);
  const diagnostic: MetaWriteDiagnostic = {
    version: 1, phase: input.notDispatched ? "not_dispatched" : "dispatch_unknown",
    outcome: input.notDispatched ? "refused" : "unknown",
    stdout: boundedMetaDiagnosticText(stdout, 512), stderr: boundedMetaDiagnosticText(stderr, 3000),
    exitCode: input.exitCode, signal: input.signal, durationMs: input.durationMs,
  };
  diagnostic.stdoutTruncated = input.stdoutTruncated === true || diagnostic.stdout !== stdout;
  diagnostic.stderrTruncated = input.stderrTruncated === true || diagnostic.stderr !== stderr;
  // Only the actual CLI's exit-4 API header has provenance. Never mine arbitrary embedded JSON.
  const api = input.exitCode === 4 && !input.signal && !input.notDispatched && !input.stderrTruncated
    ? stderr.match(/^Error: API error \((\d{1,7}|None)\): ([^\r\n]*)(?:\r?\n([\s\S]*))?$/) : null;
  if (api) {
    diagnostic.phase = "provider_response";
    if (api[1] !== "None") diagnostic.providerCode = Number(api[1]);
    diagnostic.outcome = metaProviderOutcome(diagnostic.providerCode);
    diagnostic.metaMessage = boundedMetaDiagnosticText(api[3]?.trim() || api[2].trim(), 768);
  }
  return diagnostic;
}

const scope = new AsyncLocalStorage<{ dispatched: boolean; token?: string; diagnostic?: MetaWriteDiagnostic }>();
export function markMetaWriteDispatch(token?: string): void {
  const current = scope.getStore();
  if (current) { current.dispatched = true; current.token = token; current.diagnostic = undefined; }
}
export function rememberMetaWriteDiagnostic(diagnostic: MetaWriteDiagnostic): void {
  const current = scope.getStore();
  if (current) current.diagnostic = diagnostic;
}

/** Covers validation/credential failures AND failures persisting a successful write. Per invocation, never global. */
export function withMetaWriteDiagnostics<T>(operation: () => Promise<T>): Promise<T> {
  return scope.run({ dispatched: false }, async () => {
    try { return await operation(); }
    catch (caught) {
      const current = scope.getStore()!;
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const existing = (error as Error & { metaWrite?: MetaWriteDiagnostic }).metaWrite;
      const diagnostic = existing ?? current.diagnostic ?? {
        version: 1 as const, phase: current.dispatched ? "dispatch_unknown" as const : "not_dispatched" as const,
        outcome: current.dispatched ? "unknown" as const : "refused" as const,
      };
      error.message = boundedMetaDiagnosticText(redactMetaDiagnostic(error.message, current.token), 1024);
      throw Object.assign(error, { metaWrite: diagnostic });
    }
  });
}
