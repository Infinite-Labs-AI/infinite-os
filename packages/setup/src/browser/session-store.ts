import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface BrowserSessionRef {
  profileRef?: string;
  resumeNonce?: string;
  lastUrl?: string;
}

export interface BrowserSessionStore {
  save(sessionKey: string, ref: BrowserSessionRef): Promise<BrowserSessionRef>;
  load(sessionKey: string): Promise<BrowserSessionRef | null>;
  clear(sessionKey: string): Promise<void>;
}

export function buildBrowserSessionKey(
  provider: string,
  contextRef?: string,
  scope?: string
): string {
  const segments = [
    scope ? `scope=${encodeURIComponent(scope)}` : null,
    `provider=${encodeURIComponent(provider)}`,
    contextRef?.trim() ? `context=${encodeURIComponent(contextRef.trim())}` : null
  ].filter((segment): segment is string => typeof segment === "string");

  return segments.join("|");
}

export function browserSessionKeyMatchesProvider(
  sessionKey: string,
  provider: string
): boolean {
  const segments = parseBrowserSessionKey(sessionKey);
  if (!segments) {
    return false;
  }

  const providerSegments = segments.filter((segment) => segment.key === "provider");
  return providerSegments.length === 1 && providerSegments[0]?.value === provider;
}

export function browserSessionKeyForProvider(
  sessionKey: string | undefined,
  provider: string
): string | undefined {
  if (typeof sessionKey !== "string" || sessionKey.length === 0) {
    return undefined;
  }
  return browserSessionKeyMatchesProvider(sessionKey, provider) ? sessionKey : undefined;
}

export function sanitizeBrowserSessionRef(value: unknown): BrowserSessionRef {
  if (!value || typeof value !== "object") {
    return {};
  }

  const candidate = value as Record<string, unknown>;
  return {
    profileRef: asOptionalString(candidate.profileRef),
    resumeNonce: asOptionalString(candidate.resumeNonce),
    lastUrl: sanitizePersistedBrowserUrl(candidate.lastUrl)
  };
}

export function createFileBrowserSessionStore(filePath: string): BrowserSessionStore {
  return {
    async save(sessionKey, ref) {
      const index = await readIndex(filePath);
      const sanitized = sanitizeBrowserSessionRef(ref);
      index[sessionKey] = sanitized;
      await writeIndex(filePath, index);
      return sanitized;
    },
    async load(sessionKey) {
      const index = await readIndex(filePath);
      return index[sessionKey] ?? null;
    },
    async clear(sessionKey) {
      const index = await readIndex(filePath);
      if (sessionKey in index) {
        delete index[sessionKey];
      }
      await writeIndex(filePath, index);
    }
  };
}

async function readIndex(filePath: string): Promise<Record<string, BrowserSessionRef>> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (raw.trim().length === 0) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const sanitized: Record<string, BrowserSessionRef> = {};

    for (const [sessionKey, value] of Object.entries(parsed)) {
      sanitized[sessionKey] = sanitizeBrowserSessionRef(value);
    }

    return sanitized;
  } catch (error) {
    if (isMissingFile(error)) {
      return {};
    }
    throw error;
  }
}

async function writeIndex(filePath: string, index: Record<string, BrowserSessionRef>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizePersistedBrowserUrl(value: unknown): string | undefined {
  const candidate = asOptionalString(value);
  if (!candidate) {
    return undefined;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

function parseBrowserSessionKey(sessionKey: string): Array<{ key: string; value: string }> | null {
  if (typeof sessionKey !== "string" || sessionKey.length === 0) {
    return null;
  }

  const segments = sessionKey.split("|");
  const parsed: Array<{ key: string; value: string }> = [];

  for (const segment of segments) {
    const separatorIndex = segment.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex !== segment.lastIndexOf("=")) {
      return null;
    }

    const key = segment.slice(0, separatorIndex);
    const encodedValue = segment.slice(separatorIndex + 1);
    if (encodedValue.length === 0) {
      return null;
    }

    try {
      parsed.push({ key, value: decodeURIComponent(encodedValue) });
    } catch {
      return null;
    }
  }

  return parsed;
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
