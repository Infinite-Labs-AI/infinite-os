import { isIP } from "node:net";
import type {
  ProductSurface,
  ProviderInstallState,
  ProviderInventoryRow,
  SetupInterview,
  SetupInterviewInput,
  SetupProviderId
} from "./types.js";

export const DEFAULT_SETUP_PROVIDERS = ["ga4", "posthog", "x"] as const satisfies readonly SetupProviderId[];
const DEFAULT_SELECTED_SETUP_PROVIDERS = ["ga4", "posthog"] as const satisfies readonly SetupProviderId[];
const DEFAULT_SELECTED_SETUP_PROVIDER_SET = new Set<SetupProviderId>(DEFAULT_SELECTED_SETUP_PROVIDERS);

export function createDefaultProviderInventory(): ProviderInventoryRow[] {
  return DEFAULT_SETUP_PROVIDERS.map((provider) => ({
    provider,
    hasAccount: false,
    installState: "unknown",
    selected: DEFAULT_SELECTED_SETUP_PROVIDER_SET.has(provider),
    recommended: provider !== "x"
  }));
}

export function parseSetupProviderIds(value: Iterable<string> | string | null | undefined): SetupProviderId[] {
  if (!value) {
    return [];
  }

  const parts = typeof value === "string" ? value.split(",") : Array.from(value);
  const selected: SetupProviderId[] = [];
  const seen = new Set<SetupProviderId>();

  for (const part of parts) {
    const normalized = part.trim().toLowerCase();
    if (!isSetupProviderId(normalized)) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    selected.push(normalized);
  }

  return selected;
}

export function normalizeSetupInterview(input: SetupInterviewInput): SetupInterview {
  const productSurface = normalizeProductSurface(input.productSurface);
  const providerInventory = normalizeProviderInventory(input.providerInventory);

  return {
    projectName: input.projectName?.trim() ?? "",
    productDescription: normalizeOptionalText(input.productDescription),
    websiteUrl: normalizeWebsiteUrl(input.websiteUrl, productSurface),
    productSurface,
    providerInventory
  };
}

export function normalizeWebsiteUrl(
  value: string | null | undefined,
  productSurface: ProductSurface
): string | undefined {
  if (productSurface !== "web") {
    return undefined;
  }

  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const candidate = normalizeUrlCandidate(trimmed);
  const parsed = new URL(candidate);
  const protocol = parsed.protocol === "http:" && isLocalDevelopmentHost(parsed.hostname) ? "http:" : "https:";
  const hostname = stripWwwPrefix(parsed.hostname);
  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");

  return `${protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ""}${path}${parsed.search}`;
}

function normalizeProviderInventory(
  input: Iterable<Partial<ProviderInventoryRow> & Pick<ProviderInventoryRow, "provider">> | undefined
): ProviderInventoryRow[] {
  const rows = new Map<SetupProviderId, ProviderInventoryRow>(
    createDefaultProviderInventory().map((row) => [row.provider, row])
  );

  for (const rawRow of input ?? []) {
    if (!isSetupProviderId(rawRow.provider)) {
      continue;
    }

    const current = rows.get(rawRow.provider);
    if (!current) {
      continue;
    }

    rows.set(rawRow.provider, {
      provider: rawRow.provider,
      hasAccount: inferHasAccount(rawRow.hasAccount ?? current.hasAccount, rawRow.installState),
      installState: normalizeInstallState(rawRow.installState) ?? current.installState,
      selected: rawRow.selected ?? current.selected,
      recommended: rawRow.recommended ?? current.recommended
    });
  }

  return DEFAULT_SETUP_PROVIDERS.map((provider) => rows.get(provider) ?? {
    provider,
    hasAccount: false,
    installState: "unknown",
    selected: DEFAULT_SELECTED_SETUP_PROVIDER_SET.has(provider),
    recommended: provider !== "x"
  });
}

function normalizeProductSurface(value: ProductSurface | null | undefined): ProductSurface {
  void value;
  return "web";
}

function normalizeInstallState(value: ProviderInstallState | undefined): ProviderInstallState | undefined {
  if (value === "installed" || value === "not_installed" || value === "unknown") {
    return value;
  }
  return undefined;
}

function hasProtocol(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(value);
}

function normalizeUrlCandidate(value: string): string {
  let normalized = value.trim();
  while (/^https?:\/\/https?:\/\//iu.test(normalized)) {
    normalized = normalized.replace(/^https?:\/\//iu, "");
  }
  return hasProtocol(normalized) ? normalized : `https://${normalized}`;
}

function stripWwwPrefix(hostname: string): string {
  if (hostname.startsWith("www.")) {
    return hostname.slice(4);
  }
  return hostname;
}

function isLocalDevelopmentHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".test")
  ) {
    return true;
  }
  return isPrivateDevelopmentIp(normalized);
}

function isPrivateDevelopmentIp(hostname: string): boolean {
  const version = isIP(hostname);
  if (version === 4) {
    const octets = hostname.split(".").map((part) => Number(part));
    const [a = 0, b = 0] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (version === 6) {
    return hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:");
  }
  return false;
}

function inferHasAccount(current: boolean, installState: ProviderInstallState | undefined): boolean {
  const normalizedInstallState = normalizeInstallState(installState);
  return normalizedInstallState === "installed" ? true : current;
}

function isSetupProviderId(value: string): value is SetupProviderId {
  return (DEFAULT_SETUP_PROVIDERS as readonly string[]).includes(value);
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
