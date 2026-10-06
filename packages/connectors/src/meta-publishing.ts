import {
  boundedMetaDiagnosticText,
  metaProviderOutcome,
  redactMetaDiagnostic
} from "./meta-write-diagnostic.js";

/** Provider-only primitives: no workspace identity, billing or cloud persistence. */
export type MetaPublishingIdentity = {
  pageId: string;
  instagramUserId: string | null;
  kind: "business" | "connected" | "page_backed" | "page_only";
};
export class MetaPublishingError extends Error {
  readonly retryable = false;
  constructor(
    readonly code: string,
    message: string,
    readonly edgePermissionRefused = false
  ) {
    super(message);
    this.name = "MetaPublishingError";
  }
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const decimalId = (value: unknown): value is string =>
  typeof value === "string" && /^\d{1,32}$/.test(value);

export async function resolveMetaPublishingIdentity(
  input: { accessToken: string; pageId: string; apiVersion?: string },
  fetcher: typeof fetch = fetch
): Promise<MetaPublishingIdentity> {
  if (!input.accessToken || !decimalId(input.pageId))
    throw new MetaPublishingError(
      "meta_identity_unavailable",
      "A stored access token and a valid posting Page are required to verify Instagram identity."
    );
  const version = input.apiVersion ?? "v25.0";
  if (!/^v\d{1,3}\.\d$/.test(version))
    throw new MetaPublishingError(
      "meta_identity_unavailable",
      "Invalid Meta API version."
    );
  const get = async (
    path: string,
    fields: string,
    token: string,
    after?: string
  ) => {
    const url = new URL(`https://graph.facebook.com/${version}/${path}`);
    url.searchParams.set("fields", fields);
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000)
      });
    } catch {
      throw new MetaPublishingError(
        "meta_identity_unavailable",
        "Meta identity verification did not answer. No create was sent."
      );
    }
    let body: Record<string, unknown>;
    try {
      const raw: unknown = await response.json();
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error();
      body = raw as Record<string, unknown>;
    } catch {
      throw new MetaPublishingError(
        "meta_identity_unavailable",
        "Meta identity verification returned an invalid response."
      );
    }
    const error = record(body.error);
    if (!response.ok || body.error) {
      const code = typeof error.code === "number" ? error.code : undefined;
      const subcode =
        typeof error.error_subcode === "number"
          ? error.error_subcode
          : undefined;
      const outcome = metaProviderOutcome(
        code,
        subcode,
        response.status,
        error.is_transient === true
      );
      if (outcome === "throttled")
        throw new MetaPublishingError(
          "provider_rate_limited",
          "Meta is limiting identity verification for this account. No create was sent."
        );
      const detail =
        typeof error.error_user_msg === "string"
          ? error.error_user_msg
          : typeof error.message === "string"
            ? error.message
            : "Meta could not verify the selected Page.";
      throw new MetaPublishingError(
        "meta_identity_unavailable",
        boundedMetaDiagnosticText(
          redactMetaDiagnostic(
            redactMetaDiagnostic(detail, token),
            input.accessToken
          ),
          768
        ),
        code === 10 || code === 200 || (code === 100 && subcode === 33)
      );
    }
    return body;
  };
  let pageToken: string | undefined;
  for (const edge of ["accounts", "assigned_pages"]) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    try {
      for (let page = 0; page < 10; page++) {
        const body = await get(
          `me/${edge}`,
          "id,access_token",
          input.accessToken,
          cursor
        );
        if (!Array.isArray(body.data))
          throw new MetaPublishingError(
            "meta_identity_unavailable",
            "Meta returned invalid Page membership data."
          );
        const selected = body.data
          .map(record)
          .find((row) => row.id === input.pageId);
        if (
          typeof selected?.access_token === "string" &&
          selected.access_token
        ) {
          pageToken = selected.access_token;
          break;
        }
        const paging = record(body.paging);
        if (!paging.next) break;
        const after = record(paging.cursors).after;
        if (
          typeof after !== "string" ||
          !/^[A-Za-z0-9_+/=-]{1,2048}$/.test(after) ||
          seen.has(after)
        )
          throw new MetaPublishingError(
            "meta_identity_unavailable",
            "Meta Page pagination could not be verified."
          );
        seen.add(after);
        cursor = after;
      }
    } catch (error) {
      if (
        !(error instanceof MetaPublishingError) ||
        !error.edgePermissionRefused
      )
        throw error;
    }
    if (pageToken) break;
  }
  const page = await get(
    input.pageId,
    "id,instagram_business_account{id},connected_instagram_account{id},connected_page_backed_instagram_account{id}",
    pageToken ?? input.accessToken
  );
  if (page.id !== input.pageId)
    throw new MetaPublishingError(
      "meta_identity_unavailable",
      "Meta returned another posting Page."
    );
  const choices: MetaPublishingIdentity[] = [];
  for (const [field, kind] of [
    ["instagram_business_account", "business"],
    ["connected_instagram_account", "connected"],
    ["connected_page_backed_instagram_account", "page_backed"]
  ] as const) {
    const value = page[field];
    if (value === undefined || value === null) continue;
    const association = record(value);
    if (!decimalId(association.id))
      throw new MetaPublishingError(
        "meta_identity_unavailable",
        "Meta returned a malformed Instagram association."
      );
    choices.push({
      pageId: input.pageId,
      instagramUserId: association.id,
      kind
    });
  }
  const real = choices.filter((value) => value.kind !== "page_backed");
  if (new Set(real.map((value) => value.instagramUserId)).size > 1)
    throw new MetaPublishingError(
      "meta_identity_unavailable",
      "The posting Page has conflicting Instagram associations."
    );
  return (
    real[0] ??
    choices[0] ?? {
      pageId: input.pageId,
      instagramUserId: null,
      kind: "page_only"
    }
  );
}

const DEFAULT_TAGS =
  "utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.name}}&utm_placement={{placement}}&ad_id={{ad.id}}&adset_id={{adset.id}}&campaign_id={{campaign.id}}";
const TAG_KEYS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_placement",
  "ad_id",
  "adset_id",
  "campaign_id"
]);

export function metaPublishingTracking(
  input: Record<string, unknown>
): string | undefined {
  const hasFeed = input.assetFeedSpec !== undefined;
  const links: unknown[] =
    hasFeed || input.linkUrl === undefined ? [] : [input.linkUrl];
  const feed = record(input.assetFeedSpec);
  if (hasFeed) {
    if (!Array.isArray(feed.link_urls) || !feed.link_urls.length)
      throw new MetaPublishingError(
        "meta_tracking_invalid",
        "Creative destination URLs must be a nonempty list."
      );
    links.push(...feed.link_urls.map((value) => record(value).website_url));
  }
  for (const link of links) {
    if (typeof link !== "string")
      throw new MetaPublishingError(
        "meta_tracking_invalid",
        "A creative destination URL is required."
      );
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new MetaPublishingError(
        "meta_tracking_invalid",
        "Use a valid destination URL."
      );
    }
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new MetaPublishingError(
        "meta_tracking_invalid",
        "Use an HTTP(S) destination URL without credentials."
      );
    const normalizeHost = (host: string) =>
      host.trim().toLowerCase().replace(/\.$/, "");
    const ownedHosts = [
      ...(process.env.SHORT_LINK_HOSTS ?? "go.infinite.fast").split(","),
      process.env.SHORT_LINK_HOST ?? "go.infinite.fast"
    ].map(normalizeHost);
    if (ownedHosts.includes(normalizeHost(url.hostname)))
      throw new MetaPublishingError(
        "meta_tracking_invalid",
        "Use the final website URL instead of an owned short link; its redirect can replace the ad tracking tags."
      );
    if (
      [...url.searchParams.keys()].some(
        (key) =>
          key.toLowerCase().startsWith("utm_") ||
          ["ad_id", "adset_id", "campaign_id"].includes(key.toLowerCase())
      )
    )
      throw new MetaPublishingError(
        "meta_tracking_invalid",
        "Use a clean destination URL; tracking belongs in urlTags."
      );
  }
  if (!links.length)
    throw new MetaPublishingError(
      "meta_tracking_invalid",
      "A website destination is required: supply linkUrl or assetFeedSpec.link_urls. Media URLs are not destinations."
    );
  const tags = input.urlTags === undefined ? DEFAULT_TAGS : input.urlTags;
  if (typeof tags !== "string" || tags.length > 4096 || !tags)
    throw new MetaPublishingError(
      "meta_tracking_invalid",
      "Invalid creative tracking tags."
    );
  const pairs = new Map<string, string>();
  for (const pair of tags.split("&")) {
    const pieces = pair.split("=");
    if (
      pieces.length !== 2 ||
      !TAG_KEYS.has(pieces[0]) ||
      pairs.has(pieces[0]) ||
      pair.includes("%")
    )
      throw new MetaPublishingError(
        "meta_tracking_invalid",
        "Invalid creative tracking tags: use all nine keys and literal unencoded macros."
      );
    pairs.set(pieces[0], pieces[1]);
  }
  const fixed: Record<string, string> = {
    utm_source: "facebook",
    utm_medium: "paid_social",
    utm_content: "{{ad.name}}",
    utm_placement: "{{placement}}",
    ad_id: "{{ad.id}}",
    adset_id: "{{adset.id}}",
    campaign_id: "{{campaign.id}}"
  };
  if (
    pairs.size !== 9 ||
    Object.entries(fixed).some(([key, value]) => pairs.get(key) !== value)
  )
    throw new MetaPublishingError(
      "meta_tracking_invalid",
      "Creative tracking must include all nine Facebook paid-social tags and literal ID/name/placement macros."
    );
  for (const [key, macro] of [
    ["utm_campaign", "{{campaign.id}}"],
    ["utm_term", "{{adset.id}}"]
  ]) {
    const value = pairs.get(key)!;
    const slug = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-_.]+|[-_.]+$/g, "");
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value
      );
    const pii =
      /[^\s@]+@[^\s@]+\.[^\s@]+/.test(value) ||
      (!uuid &&
        value.replace(/[^0-9]/g, "").length >= 7 &&
        /[0-9][\s().-]{0,2}[0-9]/.test(value));
    if (
      value !== macro &&
      (!value || value.length > 100 || slug !== value || pii)
    )
      throw new MetaPublishingError(
        "meta_tracking_invalid",
        "Invalid campaign or ad-set tracking code. Use its safe convention code or the ID macro."
      );
  }
  return tags;
}
/** Shared with the terminal's existing ad-name/PII contract. */
export function isMetaAdTrackingName(name: string): boolean {
  if (!name || name.length > 160) return false;
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) return false;
  if (!/^[a-z0-9._-]+$/.test(name) || /-{2,}/.test(name)) return false;
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(name)) return false;
  const digits = name.replace(/[^0-9]/g, "");
  return !(digits.length >= 7 && /[0-9][\s().-]{0,2}[0-9]/.test(name));
}
export function assertMetaAdTrackingName(name: string): void {
  if (!isMetaAdTrackingName(name))
    throw new MetaPublishingError(
      "meta_tracking_invalid",
      "The ad name is its utm_content: use lowercase letters, digits, dots, underscores or single hyphens, without personal data."
    );
}

export function safeMetaWriteErrorFields(error: unknown): {
  metaWrite?: Record<string, unknown>;
  metaMessage?: string;
} {
  const raw = record(record(error).metaWrite);
  if (
    raw.version !== 1 ||
    !["not_dispatched", "provider_response", "dispatch_unknown"].includes(
      String(raw.phase)
    ) ||
    !["refused", "throttled", "temporary", "unknown"].includes(
      String(raw.outcome)
    )
  )
    return {};
  const result: Record<string, unknown> = {
    version: 1,
    phase: raw.phase,
    outcome: raw.outcome
  };
  for (const [key, limit] of [
    ["metaMessage", 768],
    ["stderr", 3000],
    ["stdout", 512]
  ] as const)
    if (typeof raw[key] === "string")
      result[key] = boundedMetaDiagnosticText(
        redactMetaDiagnostic(raw[key]),
        limit
      );
  for (const key of [
    "providerCode",
    "providerSubcode",
    "httpStatus",
    "durationMs",
    "exitCode"
  ] as const)
    if (typeof raw[key] === "number" && Number.isSafeInteger(raw[key]))
      result[key] = raw[key];
  for (const key of ["stdoutTruncated", "stderrTruncated"] as const)
    if (typeof raw[key] === "boolean") result[key] = raw[key];
  if (
    raw.signal === null ||
    (typeof raw.signal === "string" && /^SIG[A-Z0-9]{1,20}$/.test(raw.signal))
  )
    result.signal = raw.signal;
  return {
    metaWrite: result,
    ...(typeof result.metaMessage === "string"
      ? { metaMessage: result.metaMessage }
      : {})
  };
}

export async function verifyMetaCreativeTracking(
  input: {
    accessToken: string;
    accountId: string;
    creativeId: string;
    apiVersion?: string;
  },
  fetcher: typeof fetch = fetch
): Promise<void> {
  const fail = (message: string) =>
    new MetaPublishingError("meta_creative_tracking_unverified", message);
  const account = input.accountId.replace(/^act_/i, "");
  if (!input.accessToken || !decimalId(account) || !decimalId(input.creativeId))
    throw fail(
      "A stored token, account and creative ID are required to verify existing creative tracking."
    );
  const version = input.apiVersion ?? "v25.0";
  if (!/^v\d{1,3}\.\d$/.test(version)) throw fail("Invalid Meta API version.");
  const url = new URL(
    `https://graph.facebook.com/${version}/${input.creativeId}`
  );
  url.searchParams.set(
    "fields",
    "id,account_id,url_tags,object_story_spec,asset_feed_spec"
  );
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { authorization: `Bearer ${input.accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    throw fail(
      "Existing creative tracking could not be verified. No ad was sent."
    );
  }
  let body: Record<string, unknown>;
  try {
    body = record(await response.json());
  } catch {
    throw fail("Meta returned invalid creative tracking evidence.");
  }
  const error = record(body.error);
  if (!response.ok || body.error) {
    const outcome = metaProviderOutcome(
      typeof error.code === "number" ? error.code : undefined,
      typeof error.error_subcode === "number" ? error.error_subcode : undefined,
      response.status,
      error.is_transient === true
    );
    if (outcome === "throttled")
      throw new MetaPublishingError(
        "provider_rate_limited",
        "Meta is limiting creative verification. No ad was sent."
      );
    const message =
      typeof error.error_user_msg === "string"
        ? error.error_user_msg
        : typeof error.message === "string"
          ? error.message
          : "Existing creative tracking could not be verified.";
    throw fail(
      boundedMetaDiagnosticText(
        redactMetaDiagnostic(message, input.accessToken),
        768
      )
    );
  }
  if (
    body.id !== input.creativeId ||
    String(body.account_id).replace(/^act_/i, "") !== account ||
    typeof body.url_tags !== "string" ||
    !body.url_tags
  )
    throw fail(
      "Existing creative belongs to another account or has no verified tracking tags. Create a tracked creative first."
    );
  const story = record(body.object_story_spec),
    feed = record(body.asset_feed_spec);
  const link =
    record(story.link_data).link ??
    record(record(record(story.video_data).call_to_action).value).link;
  try {
    metaPublishingTracking({
      urlTags: body.url_tags,
      ...(Object.keys(feed).length > 0
        ? { assetFeedSpec: feed }
        : { linkUrl: link })
    });
  } catch {
    throw fail(
      "Existing creative tracking or destination does not satisfy the publishing contract. Create a tracked creative first."
    );
  }
}
