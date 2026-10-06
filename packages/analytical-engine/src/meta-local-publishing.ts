import { createHash, randomUUID } from "node:crypto";
import type { InfiniteOsDb } from "@infinite-os/db";
import type { SessionContext } from "@infinite-os/runtime";
import {
  MetaPublishingError,
  resolveMetaPublishingIdentity,
  safeMetaWriteErrorFields,
  type MetaAdsCredential,
  type MetaPublishingIdentity
} from "@infinite-os/connectors";

const accountKey = (account: string) => account.replace(/^act_/i, "");
export async function assertLocalMetaCooldown(
  db: InfiniteOsDb,
  account: string,
  now = new Date()
): Promise<void> {
  const row = await db.one<{ throttle_until: string | Date }>(
    `select max(throttle_until) as throttle_until from (
    select throttle_until from meta_local_publish_cooldown where account_id=$1 and throttle_until>$2::timestamptz
    union all
    select created_at+interval '45 minutes' from integration_audit_log
      where status='failed' and details->>'account_id'=$1
        and created_at>$2::timestamptz-interval '45 minutes' and created_at<=$2::timestamptz
        and details#>>'{meta_write,version}'='1'
        and ((details#>>'{meta_write,phase}' in ('provider_response','dispatch_unknown')
        and (details#>>'{meta_write,outcome}'='throttled' or details#>>'{meta_write,httpStatus}'='429'
          or details#>>'{meta_write,providerSubcode}'='2446079'
          or details#>>'{meta_write,providerCode}' in ('4','17','32','613','80000','80001','80002','80003','80004','80005','80006','80007','80008','80009','80010','80011','80012','80013','80014'))) or (details->>'provider_read_throttled'='true' and details#>>'{meta_write,phase}'='not_dispatched'))
    ) holds having max(throttle_until) is not null`,
    [accountKey(account), now.toISOString()]
  );
  if (row)
    throw new MetaPublishingError(
      "meta_provider_cooldown",
      `Meta is limiting this account. Retry after ${new Date(row.throttle_until).toISOString()}. No write was sent.`
    );
}
export async function recordLocalMetaCooldown(
  db: InfiniteOsDb,
  account: string,
  error: unknown,
  now = new Date()
): Promise<void> {
  const detail = safeMetaWriteErrorFields(error).metaWrite;
  const code = detail?.providerCode,
    subcode = detail?.providerSubcode;
  const observedThrottle =
    detail?.phase !== "not_dispatched" &&
    (detail?.outcome === "throttled" ||
      detail?.httpStatus === 429 ||
      subcode === 2446079 ||
      (typeof code === "number" &&
        ([4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014))));
  const readThrottle =
    error !== null &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "provider_rate_limited";
  if (!observedThrottle && !readThrottle) return;
  await db.query(
    `insert into meta_local_publish_cooldown(account_id,throttle_until) values($1,$2::timestamptz)
    on conflict(account_id) do update set throttle_until=greatest(meta_local_publish_cooldown.throttle_until,excluded.throttle_until)`,
    [accountKey(account), new Date(now.getTime() + 45 * 60_000).toISOString()]
  );
}

/** Local caller-owned scope. A cloud host uses its own authenticated store instead. */
export function localMetaIntentHash(entity: string, input: unknown): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .filter(([, item]) => item !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, canonical(item)])
          )
        : value;
  return createHash("sha256")
    .update(JSON.stringify({ entity, input: canonical(input) }))
    .digest("hex");
}

export function localMetaIdentityBinding(
  credential: MetaAdsCredential,
  credentialVersion: string,
  pageId: string
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        credentialVersion,
        credential.adAccountId,
        credential.apiVersion ?? null,
        pageId,
        credential.accessToken
      ])
    )
    .digest("hex");
}
const localCredentialSnapshots = new WeakMap<
  MetaAdsCredential,
  { version: string; pageId?: string }
>();
/** Invocation metadata attached to the already decrypted snapshot; never an identity/session cache. */
export function bindLocalMetaCredentialSnapshot(
  credential: MetaAdsCredential,
  snapshot: { version: string; pageId?: string }
): void {
  localCredentialSnapshots.set(credential, { ...snapshot });
}
export function localMetaCredentialVersion(credential: MetaAdsCredential): {
  version: string;
  pageId?: string;
} {
  const snapshot = localCredentialSnapshots.get(credential);
  if (!snapshot)
    throw new MetaPublishingError(
      "credential_binding_changed",
      "The local Meta credential has no authoritative snapshot."
    );
  return snapshot;
}

export async function resolveLocalMetaIdentity(
  input: {
    db: InfiniteOsDb;
    context: SessionContext;
    sourceId: string;
    credential: MetaAdsCredential;
    pageId: string;
    operationId: string;
    credentialVersion: string;
    expectedInstagramUserId?: string;
  },
  deps: {
    verify?: () => Promise<MetaPublishingIdentity>;
    now?: () => Date;
    sleep?: () => Promise<void>;
  } = {}
): Promise<MetaPublishingIdentity> {
  const { db, context, sourceId, credential, pageId, operationId } = input;
  if (
    !operationId ||
    operationId.trim() !== operationId ||
    operationId.length > 200 ||
    !input.credentialVersion
  )
    throw new MetaPublishingError(
      "meta_identity_scope_invalid",
      "Use a stable launchId or clientToken for local identity verification."
    );
  const token = credential.accessToken;
  if (typeof token !== "string" || !token)
    throw new MetaPublishingError(
      "meta_identity_unavailable",
      "Local publishing requires a stored access token to verify the posting Page."
    );
  // The token is hashed in memory; only the opaque binding digest is persisted.
  const binding = localMetaIdentityBinding(
    credential,
    input.credentialVersion,
    pageId
  );
  const keys = [
    context.workspaceId,
    sourceId,
    context.actorId,
    operationId,
    binding
  ];
  const where =
    "workspace_id=$1 and source_id=$2 and actor_id=$3 and operation_id=$4 and binding_hash=$5";
  const now = deps.now ?? (() => new Date()),
    sleep =
      deps.sleep ??
      (() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
  const project = (raw: unknown): MetaPublishingIdentity => {
    const row =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    if (
      row.pageId !== pageId ||
      !(
        (row.kind === "page_only" && row.instagramUserId === null) ||
        (typeof row.kind === "string" &&
          ["business", "connected", "page_backed"].includes(row.kind) &&
          typeof row.instagramUserId === "string" &&
          /^\d{1,32}$/.test(row.instagramUserId))
      )
    )
      throw new MetaPublishingError(
        "meta_identity_unavailable",
        "Stored Instagram identity is invalid."
      );
    const identity = {
      pageId,
      instagramUserId: row.instagramUserId as string | null,
      kind: row.kind as MetaPublishingIdentity["kind"]
    };
    if (
      input.expectedInstagramUserId !== undefined &&
      identity.instagramUserId !== input.expectedInstagramUserId
    )
      throw new MetaPublishingError(
        "meta_identity_mismatch",
        "The supplied Instagram identity does not match the selected Page."
      );
    return identity;
  };
  for (let attempt = 0; attempt < 50; attempt++) {
    const at = now().toISOString();
    const cached = await db.one<{ identity_json: unknown }>(
      `select identity_json from meta_local_publish_identity where ${where} and verified_at>$6::timestamptz-interval '10 minutes' and verified_at<=$6::timestamptz`,
      [...keys, at]
    );
    if (cached) return project(cached.identity_json);
    const claimToken = randomUUID();
    const claim = await db.one<{ identity_json: unknown }>(
      `insert into meta_local_publish_identity(workspace_id,source_id,actor_id,operation_id,binding_hash,claim_token,claim_until)
      values($1,$2,$3,$4,$5,$7,$6::timestamptz+interval '2 minutes')
      on conflict(workspace_id,source_id,actor_id,operation_id) do update set binding_hash=excluded.binding_hash,verified_at=null,
        identity_json=case when meta_local_publish_identity.binding_hash=excluded.binding_hash then meta_local_publish_identity.identity_json else null end,
        claim_token=excluded.claim_token,claim_until=excluded.claim_until
      where (meta_local_publish_identity.claim_until is null or meta_local_publish_identity.claim_until<=$6::timestamptz)
        and (meta_local_publish_identity.binding_hash<>$5 or meta_local_publish_identity.verified_at is null or meta_local_publish_identity.verified_at<=$6::timestamptz-interval '10 minutes')
      returning identity_json`,
      [...keys, at, claimToken]
    );
    if (!claim) {
      await sleep();
      continue;
    }
    try {
      const pinned =
        claim.identity_json === null ? null : project(claim.identity_json);
      const identity = project(
        await (
          deps.verify ??
          (() =>
            resolveMetaPublishingIdentity({
              accessToken: token,
              pageId,
              apiVersion: credential.apiVersion
            }))
        )()
      );
      if (pinned && pinned.instagramUserId !== identity.instagramUserId)
        throw new MetaPublishingError(
          "meta_identity_changed",
          "The Page Instagram identity changed. Use a new launch and confirm it again."
        );
      const saved = await db.one(
        `update meta_local_publish_identity set identity_json=$8::jsonb,verified_at=$6::timestamptz,claim_token=null,claim_until=null
        where ${where} and claim_token=$7 and (identity_json is null or identity_json->>'instagramUserId' is not distinct from ($8::jsonb)->>'instagramUserId') returning operation_id`,
        [...keys, now().toISOString(), claimToken, JSON.stringify(identity)]
      );
      if (!saved)
        throw new MetaPublishingError(
          "meta_identity_changed",
          "The publishing identity changed during verification. Nothing was sent."
        );
      return identity;
    } catch (error) {
      await db
        .query(
          `update meta_local_publish_identity set claim_token=null,claim_until=null where ${where} and claim_token=$6`,
          [...keys, claimToken]
        )
        .catch(() => undefined);
      throw error;
    }
  }
  throw new MetaPublishingError(
    "meta_identity_busy",
    "Another action is verifying this launch. Retry with the same clientToken."
  );
}
