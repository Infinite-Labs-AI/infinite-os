export interface QueryAdvisorInput {
  message: string;
  workspaceId: string;
  actorId: string;
  sessionId: string;
  surface: "api" | "app" | "cli";
  now?: Date;
  recentMessages?: Array<{ role?: unknown; content?: unknown }>;
  curatedMemory?: Array<{ scope?: unknown; fact?: unknown }>;
  recalledSessions?: Array<{ id?: unknown; title?: unknown; snippet?: unknown; lastMatchedAt?: unknown }>;
}

export interface QueryAdvisorResponse {
  message?: string;
  effectiveMessage?: string;
  resolvedXIdentity?: ResolvedXIdentity;
  memoryFacts?: Array<{ scope: "source_naming"; fact: string }>;
  progressNotes?: string[];
  promptSections?: string[];
}

interface ResolvedXIdentity {
  sourceId: string;
  connectionName: string;
  username?: string;
  accountExternalId?: string;
  status?: string;
  lastSyncedAt?: string;
  latestPostPublishedAt?: string;
  earliestPostPublishedAt?: string;
  syncedPostCount?: number;
}

export interface InfiniteOsQueryAdvisor {
  advise(input: QueryAdvisorInput): Promise<QueryAdvisorResponse | undefined> | QueryAdvisorResponse | undefined;
}

export interface ConnectedXIdentity {
  sourceId: string;
  connectionName: string;
  username?: string;
  accountExternalId?: string;
  status?: string;
  lastSyncedAt?: string;
  latestPostPublishedAt?: string;
  earliestPostPublishedAt?: string;
  syncedPostCount?: number;
}

export interface ConnectedXIdentityLookupDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface QueryRefinementToolResult {
  name?: string;
  result?: unknown;
}

export type QueryFamily =
  | "best_post"
  | "comment_count"
  | "follower_count"
  | "post_count"
  | "revenue_source"
  | "recognized_revenue"
  | "source_status"
  | "site_visitors"
  | "visitor_channel_breakdown"
  | "signup_channel_breakdown"
  | "signup_count"
  | "site_conversion_rate"
  | "conversion_channel_breakdown"
  | "other";

export function createDbBackedConnectedXIdentityLookup(
  db: ConnectedXIdentityLookupDb
): (workspaceId: string) => Promise<ConnectedXIdentity[]> {
  return async (workspaceId) => {
    const rows = await db.query<{
      sourceId?: string;
      connectionName?: string;
      username?: string | null;
      accountExternalId?: string | null;
      status?: string;
      lastSyncedAt?: string | Date | null;
      latestPostPublishedAt?: string | Date | null;
      earliestPostPublishedAt?: string | Date | null;
      syncedPostCount?: string | number | null;
    }>(
      `
        select
          s.id as "sourceId",
          s.connection_name as "connectionName",
          s.account_external_id as "accountExternalId",
          s.status,
          s.last_synced_at as "lastSyncedAt",
          latest.username,
          post_bounds.latest_published_at as "latestPostPublishedAt",
          post_bounds.earliest_published_at as "earliestPostPublishedAt",
          post_bounds.synced_post_count as "syncedPostCount"
        from sources s
        left join lateral (
          select xp.username
          from x_profile_snapshot xp
          where xp.workspace_id = s.workspace_id
            and xp.source_id = s.id
          order by xp.captured_at desc
          limit 1
        ) latest on true
        left join lateral (
          select
            max(xp.published_at) as latest_published_at,
            min(xp.published_at) as earliest_published_at,
            count(*)::int as synced_post_count
          from x_post xp
          where xp.workspace_id = s.workspace_id
            and xp.source_id = s.id
        ) post_bounds on true
        where s.workspace_id = $1
          and s.provider = 'x'
          and s.status in ('connected', 'degraded')
        order by s.connection_name, s.id
      `,
      [workspaceId]
    );
    return rows
      .flatMap((row): ConnectedXIdentity[] => {
        const sourceId = stringValue(row.sourceId);
        const connectionName = stringValue(row.connectionName);
        if (!sourceId || !connectionName) {
          return [];
        }
        return [
          {
            sourceId,
            connectionName,
            username: normalizeUsername(row.username),
            accountExternalId: normalizeUsername(row.accountExternalId),
            status: stringValue(row.status),
            lastSyncedAt: isoStringValue(row.lastSyncedAt),
            latestPostPublishedAt: isoStringValue(row.latestPostPublishedAt),
            earliestPostPublishedAt: isoStringValue(row.earliestPostPublishedAt),
            syncedPostCount: numberValue(row.syncedPostCount)
          }
        ];
      });
  };
}

export function createSourceAwareQueryAdvisor(options: {
  listConnectedXIdentities: (workspaceId: string) => Promise<ConnectedXIdentity[]>;
  now?: () => Date;
}): InfiniteOsQueryAdvisor {
  const now = options.now ?? (() => new Date());
  return {
    async advise(input) {
      const pendingBusinessMetricQuestion = pendingBusinessMetricClarificationQuestion(input.recentMessages);
      const businessMetricReply = normalizeBusinessMetricClarificationReply(input.message);
      if (pendingBusinessMetricQuestion && businessMetricReply) {
        const explicitTimeScope = extractTimeScopePhrase(input.message);
        const businessMetricBaseQuestion = explicitTimeScope
          ? removeTimeScopePhrase(pendingBusinessMetricQuestion)
          : pendingBusinessMetricQuestion;
        const resolvedBusinessMetricQuestion = appendBusinessMetricToQuestion(businessMetricBaseQuestion, businessMetricReply);
        if (explicitTimeScope) {
          return {
            effectiveMessage: `${resolvedBusinessMetricQuestion} ${explicitTimeScope}`.trim(),
            promptSections: [
              "Resolved missing business metric scope for this turn:",
              `Original question: ${pendingBusinessMetricQuestion}`,
              `Clarifying business metric reply: ${input.message}`,
              "Interpret this turn as a clarification reply that resolves the previously ambiguous business metric target and time period."
            ]
          };
        }
        const followUpTimeScopeMessage = missingTimeScopeClarificationMessage(resolvedBusinessMetricQuestion);
        if (followUpTimeScopeMessage) {
          return {
            effectiveMessage: resolvedBusinessMetricQuestion,
            message: `For "${resolvedBusinessMetricQuestion}", ${lowercaseFirst(followUpTimeScopeMessage)}`,
            promptSections: [
              "Resolved missing business metric scope for this turn:",
              `Original question: ${pendingBusinessMetricQuestion}`,
              `Clarifying business metric reply: ${input.message}`,
              "Interpret this turn as a clarification reply that resolves the previously ambiguous business metric target."
            ]
          };
        }
        return {
          effectiveMessage: resolvedBusinessMetricQuestion,
          promptSections: [
            "Resolved missing business metric scope for this turn:",
            `Original question: ${pendingBusinessMetricQuestion}`,
            `Clarifying business metric reply: ${input.message}`,
            "Interpret this turn as a clarification reply that resolves the previously ambiguous business metric target."
          ]
        };
      }
      const missingBusinessMetricMessage = missingBusinessMetricClarificationMessage(input.message);
      if (missingBusinessMetricMessage) {
        return {
          message: missingBusinessMetricMessage
        };
      }
      const pendingTimeScopeQuestion = pendingTimeScopeClarificationQuestion(input.recentMessages);
      if (pendingTimeScopeQuestion && hasExplicitTimeScope(input.message)) {
        return {
          effectiveMessage: `${pendingTimeScopeQuestion} ${input.message}`.trim(),
          promptSections: [
            "Resolved missing time scope for this turn:",
            `Original question: ${pendingTimeScopeQuestion}`,
            `Clarifying time scope reply: ${input.message}`,
            "Interpret this turn as a clarification reply that resolves the previously missing time period."
          ]
        };
      }
      const missingTimeScopeMessage = missingTimeScopeClarificationMessage(input.message);
      if (missingTimeScopeMessage) {
        return {
          message: missingTimeScopeMessage
        };
      }
      const businessTimeScopeSections = explicitBusinessTimeScopePromptSections(input.message, input.now ?? new Date());
      if (businessTimeScopeSections.length > 0 && !isPotentialXIdentityQuestion(input.message)) {
        return {
          promptSections: businessTimeScopeSections
        };
      }
      const workspaceSnapshotSections = broadWorkspaceSnapshotPromptSections(input.message);
      if (workspaceSnapshotSections.length > 0 && !isPotentialXIdentityQuestion(input.message)) {
        return {
          promptSections: workspaceSnapshotSections
        };
      }
      const pendingQuestion = pendingXClarificationQuestion(input.recentMessages);
      if (pendingQuestion) {
        const identities = dedupeConnectedXIdentities(await options.listConnectedXIdentities(input.workspaceId));
        const selectedIdentity = resolveIdentitySelection(input.message, identities);
        if (selectedIdentity) {
          return {
            effectiveMessage: pendingQuestion,
            resolvedXIdentity: {
              sourceId: selectedIdentity.sourceId,
              connectionName: selectedIdentity.connectionName,
              username: selectedIdentity.username,
              accountExternalId: selectedIdentity.accountExternalId,
              status: selectedIdentity.status,
              lastSyncedAt: selectedIdentity.lastSyncedAt,
              latestPostPublishedAt: selectedIdentity.latestPostPublishedAt,
              earliestPostPublishedAt: selectedIdentity.earliestPostPublishedAt,
              syncedPostCount: selectedIdentity.syncedPostCount
            },
            memoryFacts: preferredXAccountFacts(selectedIdentity),
            progressNotes: [
              "Checking connected X accounts.",
              `Resolved X account context: ${selectedIdentity.username ? `@${selectedIdentity.username}` : selectedIdentity.connectionName}.`
            ],
            promptSections: [
              "Resolved X account context for this turn:",
              JSON.stringify(resolvedXIdentityPromptPayload(selectedIdentity)),
              "Interpret this turn as a clarification reply that resolves the previously ambiguous X account selection.",
              `If you need to narrow X data to this account, use a filter with field \`source_id\` and value \`${selectedIdentity.sourceId}\`. Do not use \`source_id\` or \`username\` as a grouped/queryable dimension unless a tool result explicitly says they are allowed dimensions.`,
              ...xQuestionPromptSections(input.message, selectedIdentity, input.now ?? now())
            ]
          };
        }
      }
      if (!isPotentialXIdentityQuestion(input.message)) {
        return undefined;
      }
      const identities = dedupeConnectedXIdentities(await options.listConnectedXIdentities(input.workspaceId));
      const explicitHandle = extractExplicitOrBareHandle(input.message);
      if (explicitHandle) {
        const matched = identities.find((identity) =>
          normalizeUsername(identity.username) === explicitHandle ||
          normalizeUsername(identity.accountExternalId) === explicitHandle
        );
        if (!matched) {
          if (identities.length === 0) {
            return {
              progressNotes: ["Checking connected X accounts."],
              message:
                `I do not have a connected X source for @${explicitHandle} yet. ` +
                "Connect that account first, or ask this question about a connected X account."
            };
          }
          return {
            progressNotes: ["Checking connected X accounts."],
            message:
              `I do not have connected X data for @${explicitHandle}. ` +
              `Connected X accounts: ${formatIdentityList(identities)}.`
          };
        }
        return {
          resolvedXIdentity: {
            sourceId: matched.sourceId,
            connectionName: matched.connectionName,
            username: matched.username,
            accountExternalId: matched.accountExternalId,
            status: matched.status,
            lastSyncedAt: matched.lastSyncedAt,
            latestPostPublishedAt: matched.latestPostPublishedAt,
            earliestPostPublishedAt: matched.earliestPostPublishedAt,
            syncedPostCount: matched.syncedPostCount
          },
          memoryFacts: preferredXAccountFacts(matched),
          progressNotes: [
            "Checking connected X accounts.",
            `Resolved X account context: @${matched.username ?? explicitHandle}.`
          ],
          promptSections: [
            "Resolved X account context for this turn:",
            JSON.stringify(resolvedXIdentityPromptPayload(matched)),
            "Interpret the user's X question as referring to this connected account unless they explicitly redirect it.",
            `If you need to narrow X data to this account, use a filter with field \`source_id\` and value \`${matched.sourceId}\`. Do not use \`source_id\` or \`username\` as a grouped/queryable dimension unless a tool result explicitly says they are allowed dimensions.`,
            ...xQuestionPromptSections(input.message, matched, input.now ?? now())
          ]
        };
      }
      if (
        !isFirstPersonXQuestion(input.message)
        && !isFirstPersonSocialStrategyQuestion(input.message)
        && !isFirstPersonSocialContentQuestion(input.message)
        && !isFirstPersonSocialEngagementPartnerQuestion(input.message)
        && !isXCurrentChannelPerformanceQuestion(input.message)
      ) {
        return undefined;
      }
      if (identities.length === 0) {
        return {
          progressNotes: ["Checking connected X accounts."],
          message: missingXIdentityMessage(input.message)
        };
      }
      const recalledIdentity = inferPreferredXIdentity(identities, input);
      if (recalledIdentity) {
        return {
          resolvedXIdentity: {
            sourceId: recalledIdentity.sourceId,
            connectionName: recalledIdentity.connectionName,
            username: recalledIdentity.username,
            accountExternalId: recalledIdentity.accountExternalId,
            status: recalledIdentity.status,
            lastSyncedAt: recalledIdentity.lastSyncedAt,
            latestPostPublishedAt: recalledIdentity.latestPostPublishedAt,
            earliestPostPublishedAt: recalledIdentity.earliestPostPublishedAt,
            syncedPostCount: recalledIdentity.syncedPostCount
          },
          memoryFacts: preferredXAccountFacts(recalledIdentity),
          progressNotes: [
            "Checking connected X accounts.",
            `Recalled preferred X account: ${recalledIdentity.username ? `@${recalledIdentity.username}` : recalledIdentity.connectionName}.`
          ],
          promptSections: [
            "Resolved X account context for this turn:",
            JSON.stringify(resolvedXIdentityPromptPayload(recalledIdentity)),
            "Interpret first-person X questions as referring to this recalled connected account unless the user says otherwise.",
            `If you need to narrow X data to this account, use a filter with field \`source_id\` and value \`${recalledIdentity.sourceId}\`. Do not use \`source_id\` or \`username\` as a grouped/queryable dimension unless a tool result explicitly says they are allowed dimensions.`,
            ...xQuestionPromptSections(input.message, recalledIdentity, input.now ?? now())
          ]
        };
      }
      const inferredIdentity = inferSinglePlausibleXIdentity(identities);
      if (inferredIdentity) {
        return {
          resolvedXIdentity: {
            sourceId: inferredIdentity.sourceId,
            connectionName: inferredIdentity.connectionName,
            username: inferredIdentity.username,
            accountExternalId: inferredIdentity.accountExternalId,
            status: inferredIdentity.status,
            lastSyncedAt: inferredIdentity.lastSyncedAt,
            latestPostPublishedAt: inferredIdentity.latestPostPublishedAt,
            earliestPostPublishedAt: inferredIdentity.earliestPostPublishedAt,
            syncedPostCount: inferredIdentity.syncedPostCount
          },
          memoryFacts: preferredXAccountFacts(inferredIdentity),
          progressNotes: [
            "Checking connected X accounts.",
            `Resolved X account context: ${inferredIdentity.username ? `@${inferredIdentity.username}` : inferredIdentity.connectionName}.`
          ],
          promptSections: [
            "Resolved X account context for this turn:",
            JSON.stringify(resolvedXIdentityPromptPayload(inferredIdentity)),
            "Interpret first-person X questions as referring to this resolved connected account unless the user says otherwise.",
            `If you need to narrow X data to this account, use a filter with field \`source_id\` and value \`${inferredIdentity.sourceId}\`. Do not use \`source_id\` or \`username\` as a grouped/queryable dimension unless a tool result explicitly says they are allowed dimensions.`,
            ...xQuestionPromptSections(input.message, inferredIdentity, input.now ?? now())
          ]
        };
      }
      if (identities.length > 1) {
        return {
          progressNotes: ["Checking connected X accounts."],
          message:
            `I found multiple connected X accounts for this workspace: ${formatIdentityChoiceList(identities)}. ` +
            "Tell me which one to use, for example `the first one` or `@yourhandle`."
        };
      }
      const [resolved] = identities;
      return {
        resolvedXIdentity: {
          sourceId: resolved.sourceId,
          connectionName: resolved.connectionName,
          username: resolved.username,
          accountExternalId: resolved.accountExternalId,
          status: resolved.status,
          lastSyncedAt: resolved.lastSyncedAt,
          latestPostPublishedAt: resolved.latestPostPublishedAt,
          earliestPostPublishedAt: resolved.earliestPostPublishedAt,
          syncedPostCount: resolved.syncedPostCount
        },
        memoryFacts: preferredXAccountFacts(resolved),
        progressNotes: [
          "Checking connected X accounts.",
          `Resolved X account context: ${resolved.username ? `@${resolved.username}` : resolved.connectionName}.`
        ],
        promptSections: [
          "Resolved X account context for this turn:",
          JSON.stringify(resolvedXIdentityPromptPayload(resolved)),
          "Interpret first-person X questions (for example: my best tweet, how many followers I have) as referring to this connected account unless the user says otherwise.",
          `If you need to narrow X data to this account, use a filter with field \`source_id\` and value \`${resolved.sourceId}\`. Do not use \`source_id\` or \`username\` as a grouped/queryable dimension unless a tool result explicitly says they are allowed dimensions.`,
          ...xQuestionPromptSections(input.message, resolved, input.now ?? now())
        ]
      };
    }
  };
}

function resolvedXIdentityPromptPayload(identity: ConnectedXIdentity): Record<string, unknown> {
  return {
    sourceId: identity.sourceId,
    connectionName: identity.connectionName,
    username: identity.username ?? null,
    accountExternalId: identity.accountExternalId ?? null,
    status: identity.status ?? null,
    lastSyncedAt: identity.lastSyncedAt ?? null,
    latestPostPublishedAt: identity.latestPostPublishedAt ?? null,
    earliestPostPublishedAt: identity.earliestPostPublishedAt ?? null,
    syncedPostCount: identity.syncedPostCount ?? null
  };
}

function isPotentialXIdentityQuestion(message: string): boolean {
  return hasExplicitHandle(message)
    || hasBareHandleReference(message)
    || isFirstPersonXQuestion(message)
    || isFirstPersonSocialStrategyQuestion(message)
    || isFirstPersonSocialContentQuestion(message)
    || isFirstPersonSocialEngagementPartnerQuestion(message)
    || isXPerformanceTodayQuestion(message)
    || isXCurrentChannelPerformanceQuestion(message);
}

function isFirstPersonXQuestion(message: string): boolean {
  return FIRST_PERSON_RE.test(message) && (
    X_METRIC_RE.test(message) ||
    (isFirstPersonExplicitXStrategyQuestion(message) && (isXStrategyQuestion(message) || isXNegativeStrategyQuestion(message)))
  );
}

function isFirstPersonExplicitXStrategyQuestion(message: string): boolean {
  return /\b(x|twitter)\b/i.test(message);
}

function isFirstPersonSocialStrategyQuestion(message: string): boolean {
  return FIRST_PERSON_RE.test(message)
    && /\b(post(?:ing)?|tweet(?:ing)?)\b/i.test(message)
    && (/\bmore of\b/i.test(message) || /\bstop\b/i.test(message));
}

function isFirstPersonSocialContentQuestion(message: string): boolean {
  return FIRST_PERSON_RE.test(message)
    && /\b(content|posts?|tweets?)\b/i.test(message)
    && /\b(type|types|kind|kinds|format|formats|performing|performance|better|best|top)\b/i.test(message);
}

function isFirstPersonSocialEngagementPartnerQuestion(message: string): boolean {
  return FIRST_PERSON_RE.test(message)
    && /\b(people|person|accounts?|handles?|users?)\b/i.test(message)
    && /\b(engaged with|interacted with|replied to|reply to|mentioned)\b/i.test(message);
}

function isSocialRecencyQuestion(message: string): boolean {
  return FIRST_PERSON_RE.test(message)
    && /\b(latest|recent|newest|last|current)\b/i.test(message)
    && /\b(post|posts|tweet|tweets)\b/i.test(message);
}

function isXPerformanceTodayQuestion(message: string): boolean {
  return /\b(tweet|tweets|post|posts|x|twitter)\b/i.test(message)
    && /\b(today|tonight|current|latest|recent|right now|as of today)\b/i.test(message)
    && /\b(best|top|performing|performance|popular|highest|most)\b/i.test(message);
}

function isXCurrentChannelPerformanceQuestion(message: string): boolean {
  return /\b(x|twitter)\b/i.test(message)
    && /\b(today|tonight|current|latest|recent|right now|as of today)\b/i.test(message)
    && /\b(performance|performing|engagement|engagements|attention|spend|channel|channels?|meta ads?|ads?)\b/i.test(message);
}

function mentionsMetaAdsSurface(message: string): boolean {
  return /\b(meta\s+ads?|facebook\s+ads?|paid\s+social)\b/i.test(message);
}

function isXFirstPostQuestion(message: string): boolean {
  return FIRST_PERSON_RE.test(message)
    && /\b(first|earliest|oldest)\b/i.test(message)
    && /\b(post|posts|tweet|tweets)\b/i.test(message);
}

function isXTimingQuestion(message: string): boolean {
  return /\b(best|worst)\s+times?\b/i.test(message) && /\b(tweet|tweets|post|posts)\b/i.test(message);
}

function xTimingPromptSections(message: string): string[] {
  if (!isXTimingQuestion(message)) {
    return [];
  }
  return [
    "For X timing-analysis questions, prefer comparing engagement buckets against posting-volume buckets before making a strong claim.",
    "A good typed plan is: compare `x_public_engagement` on `queryable.vw_x_post_public_metrics` grouped by `published_hour_utc` and/or `published_weekday_utc`, then compare `x_post_count` on `queryable.vw_x_authored_activity` with the same buckets.",
    "If you only have summed engagement and not normalized post volume, answer conservatively and say the result is directional rather than definitive."
  ];
}

function xQuestionPromptSections(message: string, identity: ConnectedXIdentity | undefined, currentTime: Date): string[] {
  return [
    ...xFreshnessPromptSections(message, identity, currentTime),
    ...xTimingPromptSections(message),
    ...xPatternPromptSections(message),
    ...xContentTypePromptSections(message),
    ...xEngagementPartnerPromptSections(message)
  ];
}

function xFreshnessPromptSections(message: string, identity: ConnectedXIdentity | undefined, currentTime: Date): string[] {
  const latestQuestion = isSocialRecencyQuestion(message);
  const firstQuestion = isXFirstPostQuestion(message);
  const sameDayPerformanceQuestion = isXPerformanceTodayQuestion(message) || isXCurrentChannelPerformanceQuestion(message);
  if (!latestQuestion && !firstQuestion && !sameDayPerformanceQuestion) {
    return [];
  }
  const sections = [
    "X recency and coverage guidance:",
    `Resolved X local coverage: ${JSON.stringify({
      sourceId: identity?.sourceId ?? null,
      lastSyncedAt: identity?.lastSyncedAt ?? null,
      latestPostPublishedAt: identity?.latestPostPublishedAt ?? null,
      earliestPostPublishedAt: identity?.earliestPostPublishedAt ?? null,
      syncedPostCount: identity?.syncedPostCount ?? null,
      currentTime: currentTime.toISOString()
    })}.`
  ];
  if (latestQuestion) {
    sections.push(
      "For latest/current/last X post questions, use live provider freshness before answering from stored rows.",
      "Call `sync_source_now` for the resolved source with `refreshWindowDays: 1`, then query the latest post from Postgres after that tool result.",
      "Do not present the latest stored row as the user's current latest tweet unless you have just run `sync_source_now` successfully in this turn."
    );
  }
  if (firstQuestion) {
    sections.push(
      "For first/earliest/oldest X post questions, local rows only prove the earliest synced public post unless full-history coverage has been explicitly verified.",
      "Before answering a first-ever X post question from stored rows, call `sync_source_now` for the resolved source with a large `refreshWindowDays` such as 3650 to expand local coverage through the X connector, then query the earliest post from Postgres.",
      "If that refreshed coverage still cannot prove full history, phrase the result as the earliest synced public post rather than the user's first tweet ever."
    );
  }
  if (sameDayPerformanceQuestion) {
    sections.push(
      "For same-day X performance questions and current/right-now X comparisons such as best/top tweets today or channel comparisons right now, if `lastSyncedAt` is missing, older than 60 minutes, or before today's UTC date, call `sync_source_now` for the resolved source with `refreshWindowDays: 1` before ranking posts or comparing channels.",
      "Treat channel-comparison prompts with today/current/right-now wording as same-day/current X performance questions.",
      mentionsMetaAdsSurface(message)
        ? "When comparing X with Meta Ads for today's/current performance, refresh the resolved X source with `sync_source_now` before comparing X with Meta Ads so the X side is not ranked from stale stored rows."
        : "When the user asks for current X performance, refresh the resolved X source with `sync_source_now` before comparing or ranking from stored rows.",
      "After a successful same-day sync, answer from `x_public_engagement` on `queryable.vw_x_post_public_metrics` filtered to today and scoped to the resolved `source_id`."
    );
  }
  return sections;
}

function xContentTypePromptSections(message: string): string[] {
  if (!isFirstPersonSocialContentQuestion(message)) {
    return [];
  }
  return [
    "For X content-type performance questions, prefer `x_public_engagement` on `queryable.vw_x_post_public_metrics` grouped by `content_type`.",
    "`content_type` is a deterministic local classification from reply status and post body text; use it for directional content-format analysis and caveat that it is not a source-native creative taxonomy.",
    "If the user asks for post type, content kind, content format, or format, treat those as aliases for `content_type`."
  ];
}

function xEngagementPartnerPromptSections(message: string): string[] {
  if (!isFirstPersonSocialEngagementPartnerQuestion(message)) {
    return [];
  }
  return [
    "For X 'people I engaged with' questions, prefer `x_comment_count` on `queryable.vw_x_authored_activity` grouped by `mentioned_handle`, not grouped by the user's own `author_id`.",
    "`mentioned_handle` is derived from @mentions in authored post text, so answer as top mentioned/replied-to handles visible in the synced authored activity and caveat that it is not a complete social graph."
  ];
}

function isXPatternQuestion(message: string): boolean {
  return /\b(had in common|have in common|what do .* have in common|analyse|analyze)\b/i.test(message)
    && /\b(tweet|tweets|post|posts)\b/i.test(message)
    && /\b(best|top|performing|performance)\b/i.test(message);
}

function isXStrategyQuestion(message: string): boolean {
  return /\bwhat should i (post|tweet|write) more of\b/i.test(message)
    || (/\b(post|tweet|write)\b/i.test(message) && /\bmore of\b/i.test(message) && /\b(x|twitter|tweet|tweets|post|posts)\b/i.test(message));
}

function isXNegativeStrategyQuestion(message: string): boolean {
  return /\bwhat should i stop (posting|tweeting|writing)\b/i.test(message)
    || (/\bstop posting\b/i.test(message) && /\b(x|twitter)\b/i.test(message));
}

function xPatternPromptSections(message: string): string[] {
  if (!isXPatternQuestion(message) && !isXStrategyQuestion(message) && !isXNegativeStrategyQuestion(message)) {
    return [];
  }
  return [
    "For X pattern-analysis questions, first identify the strongest posts, then compare them for recurring themes, tone, format, and reply-versus-original-post patterns.",
    "Do not stop at naming a single winner. Compare at least a few top posts and extract one or two grounded common traits.",
    "If one standout post succeeded for a different reason, mention that contrast explicitly.",
    ...(isXStrategyQuestion(message)
      ? [
          "If the user is asking what to post more of, turn the strongest recurring traits into 2-3 concrete posting recommendations rather than stopping at description.",
          "Keep those recommendations grounded in the returned top posts rather than generic social-media advice."
        ]
      : []),
    ...(isXNegativeStrategyQuestion(message)
      ? [
          "If the user is asking what to stop posting, identify weak or low-signal patterns cautiously. If the available data only shows winners, explicitly separate grounded observations from general anti-pattern advice.",
          "Do not pretend the returned top-post data proves what to stop doing unless the evidence genuinely supports that claim."
        ]
      : [])
  ];
}

function hasExplicitHandle(message: string): boolean {
  return Boolean(extractExplicitHandle(message));
}

function hasBareHandleReference(message: string): boolean {
  return Boolean(extractBareHandleReference(message));
}

function extractExplicitHandle(message: string): string | undefined {
  const match = message.match(/(^|[\s(])@([A-Za-z0-9_]{1,15})\b/);
  return normalizeUsername(match?.[2]);
}

function extractExplicitOrBareHandle(message: string): string | undefined {
  return extractExplicitHandle(message) ?? extractBareHandleReference(message);
}

function extractBareHandleReference(message: string): string | undefined {
  if (!X_METRIC_RE.test(message)) {
    return undefined;
  }
  const patterns = [
    /\b(?:for|about)\s+(?:x\s+|twitter\s+)?(?:account|handle|user|username)\s+@?([A-Za-z0-9_]{1,15})\b/i,
    /\bdoes\s+@?([A-Za-z0-9_]{1,15})\s+(?:have|post|tweet|engage|follow|reply|comment|perform)\b/i,
    /\bhas\s+@?([A-Za-z0-9_]{1,15})\s+made\b/i,
    /^\s*@?([A-Za-z0-9_]{1,15})\b\s+(?:have|has)\b/i,
    /\b@?([A-Za-z0-9_]{1,15})['’]s\s+(?:followers?|tweets?|posts?|engagement|engagements|performance)\b/i
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    const normalized = normalizeUsername(match?.[1]);
    if (normalized && !DISALLOWED_BARE_HANDLE_TOKENS.has(normalized)) {
      return normalized;
    }
  }
  return undefined;
}

const DISALLOWED_BARE_HANDLE_TOKENS = new Set([
  "i",
  "im",
  "ive",
  "my",
  "me",
  "our",
  "we",
  "you",
  "your",
  "he",
  "she",
  "they",
  "them",
  "it",
  "what",
  "whats",
  "who",
  "when",
  "where",
  "why",
  "how",
  "the",
  "a",
  "an",
  "or",
  "and",
  "same",
  "more",
  "less",
  "attention"
]);

function formatIdentityList(identities: ConnectedXIdentity[]): string {
  return identities
    .map((identity) =>
      identity.username
        ? `@${identity.username} (${identity.connectionName})`
        : identity.connectionName
    )
    .join(", ");
}

function formatIdentityChoiceList(identities: ConnectedXIdentity[]): string {
  return identities
    .map((identity, index) =>
      `${index + 1}. ${
        identity.username
          ? `@${identity.username} (${identity.connectionName})`
          : identity.connectionName
      }`
    )
    .join("; ");
}

function dedupeConnectedXIdentities(identities: ConnectedXIdentity[]): ConnectedXIdentity[] {
  const seen = new Set<string>();
  const unique: ConnectedXIdentity[] = [];
  for (const identity of identities) {
    const key = `${identity.sourceId}:${normalizeUsername(identity.username) ?? ""}:${identity.connectionName.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(identity);
  }
  return unique;
}

function normalizeUsername(value: unknown): string | undefined {
  const trimmed = stringValue(value)?.replace(/^@/, "").trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isoStringValue(value: unknown): string | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  const raw = stringValue(value);
  if (!raw) {
    return undefined;
  }
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : raw;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function inferPreferredXIdentity(
  identities: ConnectedXIdentity[],
  input: QueryAdvisorInput
): ConnectedXIdentity | undefined {
  const haystacks = [
    ...(input.curatedMemory ?? []).map((item) => String(item.fact ?? "")),
    ...(input.recentMessages ?? []).map((item) => String(item.content ?? "")),
    ...(input.recalledSessions ?? []).flatMap((item) => [String(item.title ?? ""), String(item.snippet ?? "")])
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  if (!haystacks.length) {
    return undefined;
  }
  const matches = identities.filter((identity) => identityMentioned(identity, haystacks));
  if (matches.length !== 1) {
    return undefined;
  }
  return matches[0];
}

function inferSinglePlausibleXIdentity(identities: ConnectedXIdentity[]): ConnectedXIdentity | undefined {
  if (identities.length < 2) {
    return identities[0];
  }
  const plausible = identities.filter((identity) => !identityLooksSynthetic(identity));
  return plausible.length === 1 ? plausible[0] : undefined;
}

function pendingXClarificationQuestion(
  recentMessages: QueryAdvisorInput["recentMessages"]
): string | undefined {
  if (!recentMessages?.length) {
    return undefined;
  }
  const assistantMessage = [...recentMessages]
    .reverse()
    .find((message) => message.role === "assistant" && typeof message.content === "string");
  if (!assistantMessage || typeof assistantMessage.content !== "string") {
    return undefined;
  }
  if (!/multiple connected X accounts/i.test(assistantMessage.content) || !/tell me which one to use/i.test(assistantMessage.content)) {
    return undefined;
  }
  const assistantIndex = recentMessages.lastIndexOf(assistantMessage);
  if (assistantIndex <= 0) {
    return undefined;
  }
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const candidate = recentMessages[index];
    if (candidate?.role !== "user" || typeof candidate.content !== "string") {
      continue;
    }
    if (isFirstPersonXQuestion(candidate.content) || isFirstPersonSocialStrategyQuestion(candidate.content)) {
      return candidate.content;
    }
  }
  return undefined;
}

function pendingTimeScopeClarificationQuestion(
  recentMessages: QueryAdvisorInput["recentMessages"]
): string | undefined {
  if (!recentMessages?.length) {
    return undefined;
  }
  const assistantMessage = [...recentMessages]
    .reverse()
    .find((message) => message.role === "assistant" && typeof message.content === "string");
  if (!assistantMessage || typeof assistantMessage.content !== "string") {
    return undefined;
  }
  const embeddedQuestionMatch = assistantMessage.content.match(/For "([^"]+)", which time period do you want/i);
  if (embeddedQuestionMatch?.[1]) {
    return embeddedQuestionMatch[1];
  }
  if (!/Which time period do you want/i.test(assistantMessage.content)) {
    return undefined;
  }
  const assistantIndex = recentMessages.lastIndexOf(assistantMessage);
  if (assistantIndex <= 0) {
    return undefined;
  }
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const candidate = recentMessages[index];
    if (candidate?.role !== "user" || typeof candidate.content !== "string") {
      continue;
    }
    return candidate.content;
  }
  return undefined;
}

function pendingBusinessMetricClarificationQuestion(
  recentMessages: QueryAdvisorInput["recentMessages"]
): string | undefined {
  if (!recentMessages?.length) {
    return undefined;
  }
  const assistantMessage = [...recentMessages]
    .reverse()
    .find((message) => message.role === "assistant" && typeof message.content === "string");
  if (!assistantMessage || typeof assistantMessage.content !== "string") {
    return undefined;
  }
  if (!/Do you mean best channel for traffic, signups, conversion rate, or revenue\?/i.test(assistantMessage.content)) {
    return undefined;
  }
  const assistantIndex = recentMessages.lastIndexOf(assistantMessage);
  if (assistantIndex <= 0) {
    return undefined;
  }
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const candidate = recentMessages[index];
    if (candidate?.role !== "user" || typeof candidate.content !== "string") {
      continue;
    }
    return candidate.content;
  }
  return undefined;
}

function normalizeBusinessMetricClarificationReply(message: string): string | undefined {
  const lower = message.trim().toLowerCase();
  if (!lower) {
    return undefined;
  }
  if (/\brevenue\b/.test(lower)) {
    return "for revenue";
  }
  if (/\b(signups?|signup)\b/.test(lower)) {
    return "for signups";
  }
  if (/\bconversion rate\b/.test(lower) || /\bconversions?\b/.test(lower) || /\bconvert(?:s|ing)?\b/.test(lower)) {
    return "for conversion rate";
  }
  if (/\btraffic\b/.test(lower) || /\bvisitors?\b/.test(lower) || /\busers?\b/.test(lower)) {
    return "for traffic";
  }
  return undefined;
}

function appendBusinessMetricToQuestion(question: string, businessMetricReply: string): string {
  const timeScope = extractTimeScopePhrase(question);
  if (!timeScope) {
    return `${question} ${businessMetricReply}`.trim();
  }
  const withoutTimeScope = removeTimeScopePhrase(question);
  return `${withoutTimeScope} ${businessMetricReply} ${timeScope}`.replace(/\s{2,}/g, " ").trim();
}

function removeTimeScopePhrase(question: string): string {
  const timeScope = extractTimeScopePhrase(question);
  if (!timeScope) {
    return question.trim();
  }
  return question.replace(new RegExp(`\\b${escapeRegExp(timeScope)}\\b`, "i"), "").replace(/\s{2,}/g, " ").trim();
}

function lowercaseFirst(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

function resolveIdentitySelection(message: string, identities: ConnectedXIdentity[]): ConnectedXIdentity | undefined {
  const explicitHandle = extractExplicitHandle(message);
  if (explicitHandle) {
    return identities.find((identity) => normalizeUsername(identity.username) === explicitHandle);
  }
  const ordinalIndex = ordinalSelectionIndex(message);
  if (ordinalIndex !== undefined && identities[ordinalIndex]) {
    return identities[ordinalIndex];
  }
  const normalized = normalizeUsername(message);
  if (normalized) {
    const usernameMatch = identities.find((identity) =>
      normalizeUsername(identity.username) === normalized ||
      normalizeUsername(identity.accountExternalId) === normalized
    );
    if (usernameMatch) {
      return usernameMatch;
    }
  }
  const usernameMatches = identities.filter((identity) => {
    const username = normalizeUsername(identity.username) ?? normalizeUsername(identity.accountExternalId);
    if (!username) {
      return false;
    }
    return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(username)}([^A-Za-z0-9_]|$)`, "i").test(message);
  });
  if (usernameMatches.length === 1) {
    return usernameMatches[0];
  }
  const lower = message.trim().toLowerCase();
  if (!lower) {
    return undefined;
  }
  const byConnectionName = identities.filter((identity) => identity.connectionName.trim().toLowerCase().includes(lower));
  if (byConnectionName.length === 1) {
    return byConnectionName[0];
  }
  const mentionedConnection = identities.filter((identity) =>
    lower.includes(identity.connectionName.trim().toLowerCase())
  );
  if (mentionedConnection.length === 1) {
    return mentionedConnection[0];
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ordinalSelectionIndex(message: string): number | undefined {
  const lower = message.toLowerCase();
  if (/\b(first|1st|number one|#1|one)\b/.test(lower)) {
    return 0;
  }
  if (/\b(second|2nd|number two|#2|two)\b/.test(lower)) {
    return 1;
  }
  if (/\b(third|3rd|number three|#3|three)\b/.test(lower)) {
    return 2;
  }
  return undefined;
}

function identityMentioned(identity: ConnectedXIdentity, haystacks: string[]): boolean {
  const username = normalizeUsername(identity.username);
  const external = normalizeUsername(identity.accountExternalId);
  const connectionName = identity.connectionName.trim().toLowerCase();
  return haystacks.some((haystack) => {
    const lower = haystack.toLowerCase();
    return (
      ((username ? lower.includes(`@${username}`) || lower.includes(username) : false) ||
      (external ? lower.includes(`@${external}`) || lower.includes(external) : false)) ||
      lower.includes(connectionName)
    );
  });
}

function identityLooksSynthetic(identity: ConnectedXIdentity): boolean {
  const tokens = [
    identity.connectionName,
    identity.username ?? "",
    identity.accountExternalId ?? ""
  ]
    .join(" ")
    .toLowerCase();
  return /\b(fixture|test|demo|example|sample|mock)\b/.test(tokens);
}

function preferredXAccountFacts(identity: ConnectedXIdentity): Array<{ scope: "source_naming"; fact: string }> {
  if (identity.username) {
    return [
      {
        scope: "source_naming",
        fact: `Prefer connected X account @${identity.username} (${identity.connectionName}) for first-person X questions.`
      }
    ];
  }
  return [
    {
      scope: "source_naming",
      fact: `Prefer connected X account ${identity.connectionName} for first-person X questions.`
    }
  ];
}

function missingXIdentityMessage(message: string): string {
  const family = classifyQueryFamily(message);
  if (shouldClarifyAlternativePlatform(message, family)) {
    return (
      "I do not have a connected X account identity for this workspace yet. " +
      "If you mean X, connect an X source first or ask with an explicit handle like `@yourhandle`. " +
      "If you mean another platform, tell me which one."
    );
  }
  return (
    "I do not have a connected X account identity for this workspace yet. " +
    "Connect an X source first, or ask with an explicit handle like `@yourhandle`."
  );
}

function explicitBusinessTimeScopePromptSections(message: string, now: Date): string[] {
  const timeScope = extractTimeScopePhrase(message);
  if (!timeScope) {
    return [];
  }
  const family = classifyQueryFamily(message);
  if (![
    "recognized_revenue",
    "revenue_source",
    "site_visitors",
    "visitor_channel_breakdown",
    "signup_count",
    "signup_channel_breakdown",
    "site_conversion_rate",
    "conversion_channel_breakdown"
  ].includes(family)) {
    return [];
  }
  const window = explicitTimeScopeWindow(timeScope, now);
  return [
    "Resolved explicit time scope for this turn:",
    `The user explicitly asked about the period: ${timeScope}.`,
    window
      ? `For this period, scope metric or breakdown queries to ${window.start} through ${window.end} (UTC date boundaries).`
      : "Carry that same time scope into any metric or breakdown query you run before answering.",
    "Do not answer from unscoped totals if the user explicitly asked for a time-bounded period."
  ];
}

function broadWorkspaceSnapshotPromptSections(message: string): string[] {
  if (!isOpenEndedAnalysisPrompt(message)) {
    return [];
  }
  return [
    "Workspace snapshot prompt guidance:",
    "For broad workspace snapshot prompts, try to gather at least one business signal (traffic, signups, conversion, or revenue) before answering strongly.",
    "If both funnel-style signals (traffic/signups/conversion) and revenue are available, try to gather at least one of each before summarizing.",
    "If you rely on `site_conversion_rate` in the answer, also try to gather the underlying `signup_count` or visitor volume so the ratio has concrete magnitude context.",
    "If X data is available, include one relevant social or operational signal only if it adds context rather than overwhelming the answer.",
    "Use compatible metric/view pairs: `x_public_engagement` belongs on `queryable.vw_x_post_public_metrics`; `x_post_count` and `x_comment_count` belong on `queryable.vw_x_authored_activity`; `x_follower_count` belongs on `queryable.vw_x_profile_public_metrics`.",
    "Do not request an X metric from a view that does not support it when building a broad workspace summary.",
    "If one or more business signals are available, lead the answer with the strongest business signal before discussing fixture/test caveats or source-quality warnings.",
    "Do not let one noisy metric dominate the entire answer when the user asked for a broad workspace read."
  ];
}

function missingBusinessMetricClarificationMessage(message: string): string | undefined {
  if (!isAmbiguousBusinessChannelQuestion(message)) {
    return undefined;
  }
  return "Do you mean best channel for traffic, signups, conversion rate, or revenue?";
}

function missingTimeScopeClarificationMessage(message: string): string | undefined {
  if (hasExplicitTimeScope(message)) {
    return undefined;
  }
  const family = classifyQueryFamily(message);
  if (family === "recognized_revenue" && isDirectRevenueQuestion(message)) {
    return "Which time period do you want for revenue: today, this week, this month, this quarter, this year, or all time?";
  }
  if (family === "revenue_source" && isDirectRevenueBreakdownQuestion(message)) {
    return "Which time period do you want for the revenue/source breakdown: today, this week, this month, this quarter, this year, or all time?";
  }
  if (family === "site_visitors" && isDirectVisitorQuestion(message)) {
    return "Which time period do you want for visitors or traffic: today, this week, this month, this quarter, this year, or all time?";
  }
  if (family === "signup_count" && isDirectSignupQuestion(message)) {
    return "Which time period do you want for signups: today, this week, this month, this quarter, this year, or all time?";
  }
  if (family === "site_conversion_rate" && isDirectConversionQuestion(message)) {
    return "Which time period do you want for conversion rate: today, this week, this month, this quarter, this year, or all time?";
  }
  if (family === "visitor_channel_breakdown" && isDirectTrafficBreakdownQuestion(message)) {
    return "Which time period do you want for the traffic/source breakdown: today, this week, this month, this quarter, this year, or all time?";
  }
  if (family === "signup_channel_breakdown" && isDirectSignupBreakdownQuestion(message)) {
    return "Which time period do you want for the signup/source breakdown: today, this week, this month, this quarter, this year, or all time?";
  }
  if (family === "conversion_channel_breakdown" && isDirectConversionBreakdownQuestion(message)) {
    return "Which time period do you want for the conversion/source breakdown: today, this week, this month, this quarter, this year, or all time?";
  }
  return undefined;
}

function hasExplicitTimeScope(message: string): boolean {
  return Boolean(extractTimeScopePhrase(message));
}

function extractTimeScopePhrase(message: string): string | undefined {
  const match = message.match(/\b(today|yesterday|tonight|this week|last week|this month|last month|this quarter|last quarter|this year|last year|all time|ever|recent|latest|past \d+|last \d+|over the last \d+)\b/i);
  return match?.[0]?.trim();
}

function explicitTimeScopeWindow(
  timeScope: string,
  now: Date
): { start: string; end: string } | undefined {
  const normalized = timeScope.trim().toLowerCase();
  const today = formatUtcDateOnly(now);
  if (normalized === "today" || normalized === "tonight") {
    return { start: today, end: today };
  }
  if (normalized === "yesterday") {
    const day = addUtcDays(now, -1);
    const value = formatUtcDateOnly(day);
    return { start: value, end: value };
  }
  if (normalized === "this week") {
    return { start: startOfUtcIsoWeek(now), end: today };
  }
  if (normalized === "last week") {
    const thisWeekStart = startOfUtcIsoWeek(now);
    const lastWeekStartDate = addUtcDays(new Date(`${thisWeekStart}T00:00:00.000Z`), -7);
    const lastWeekEndDate = addUtcDays(new Date(`${thisWeekStart}T00:00:00.000Z`), -1);
    return {
      start: formatUtcDateOnly(lastWeekStartDate),
      end: formatUtcDateOnly(lastWeekEndDate)
    };
  }
  if (normalized === "this month") {
    return { start: formatDateParts(now.getUTCFullYear(), now.getUTCMonth() + 1, 1), end: today };
  }
  if (normalized === "last month") {
    const year = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
    const month = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();
    const end = formatDateParts(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    const endDate = addUtcDays(new Date(`${end}T00:00:00.000Z`), -1);
    return {
      start: formatDateParts(year, month, 1),
      end: formatUtcDateOnly(endDate)
    };
  }
  if (normalized === "this quarter") {
    const quarterMonth = Math.floor(now.getUTCMonth() / 3) * 3 + 1;
    return { start: formatDateParts(now.getUTCFullYear(), quarterMonth, 1), end: today };
  }
  if (normalized === "last quarter") {
    const quarterMonth = Math.floor(now.getUTCMonth() / 3) * 3 + 1;
    const thisQuarterStart = new Date(`${formatDateParts(now.getUTCFullYear(), quarterMonth, 1)}T00:00:00.000Z`);
    const lastQuarterEnd = addUtcDays(thisQuarterStart, -1);
    const lastQuarterMonth = quarterMonth === 1 ? 10 : quarterMonth - 3;
    const lastQuarterYear = quarterMonth === 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
    return {
      start: formatDateParts(lastQuarterYear, lastQuarterMonth, 1),
      end: formatUtcDateOnly(lastQuarterEnd)
    };
  }
  if (normalized === "this year") {
    return { start: formatDateParts(now.getUTCFullYear(), 1, 1), end: today };
  }
  if (normalized === "last year") {
    return {
      start: formatDateParts(now.getUTCFullYear() - 1, 1, 1),
      end: formatDateParts(now.getUTCFullYear() - 1, 12, 31)
    };
  }
  const countMatch = normalized.match(/^(?:past|last|over the last)\s+(\d+)$/);
  if (countMatch) {
    const count = Number(countMatch[1]);
    if (Number.isFinite(count) && count > 0) {
      return {
        start: formatUtcDateOnly(addUtcDays(now, -(count - 1))),
        end: today
      };
    }
  }
  return undefined;
}

function formatDateParts(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function formatUtcDateOnly(date: Date): string {
  return formatDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function startOfUtcIsoWeek(date: Date): string {
  const day = date.getUTCDay() || 7;
  return formatUtcDateOnly(addUtcDays(date, -(day - 1)));
}

function addUtcDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function isAmbiguousBusinessChannelQuestion(message: string): boolean {
  const asksAboutChannel = /\b(best|top|strongest|performing|winning)\b.*\b(source|channel|campaign)\b/i.test(message)
    || /\b(source|channel|campaign)\b.*\b(best|top|strongest|performing|winning)\b/i.test(message);
  if (!asksAboutChannel) {
    return false;
  }
  const hasMetricDisambiguator = /\b(revenue|traffic|visitors|users|signups?|conversion|conversions|convert|converts|converting)\b/i.test(message);
  return !hasMetricDisambiguator;
}

function isDirectRevenueQuestion(message: string): boolean {
  return /\b(how much revenue|what revenue did|revenue total|total revenue|how is revenue doing|how are revenues doing)\b/i.test(message);
}

function isDirectRevenueBreakdownQuestion(message: string): boolean {
  return /\b(which|what)\b.*\b(source|channel|provider)\b.*\brevenue\b/i.test(message)
    || /\brevenue\b.*\b(source|channel|provider)\b/i.test(message);
}

function isDirectVisitorQuestion(message: string): boolean {
  return /\b(how many visitors|how much traffic|how many users|how is traffic doing|how are visitors doing|how are users doing)\b/i.test(message);
}

function isDirectSignupQuestion(message: string): boolean {
  return /\b(how many signups|how many signed up|signup total|total signups|how are signups doing|how is signup growth doing)\b/i.test(message);
}

function isDirectConversionQuestion(message: string): boolean {
  return /\b(what('?s| is)? (the )?conversion rate|how is conversion|conversion rate|how are conversions doing|how is conversion doing)\b/i.test(message);
}

function isDirectTrafficBreakdownQuestion(message: string): boolean {
  return /\b(which|what)\b.*\b(source|channel|campaign)\b.*\b(traffic|visitors|users)\b/i.test(message)
    || /\b(traffic|visitors|users)\b.*\b(source|channel|campaign)\b/i.test(message);
}

function isDirectSignupBreakdownQuestion(message: string): boolean {
  return /\b(which|what)\b.*\b(source|channel|campaign)\b.*\b(signups?|signup)\b/i.test(message)
    || /\b(signups?|signup)\b.*\b(source|channel|campaign)\b/i.test(message);
}

function isDirectConversionBreakdownQuestion(message: string): boolean {
  return /\b(which|what)\b.*\b(source|channel|campaign)\b.*\b(conversion|conversions|convert)\b/i.test(message)
    || /\b(conversion|conversions|convert)\b.*\b(source|channel|campaign)\b/i.test(message)
    || /\b(which|what)\b.*\b(source|channel|campaign)\b.*\b(converts?|converting)\b/i.test(message);
}

function shouldClarifyAlternativePlatform(message: string, family: QueryFamily): boolean {
  if (mentionsExplicitXSurface(message)) {
    return false;
  }
  if (family === "comment_count" || family === "follower_count" || family === "post_count" || family === "best_post") {
    return true;
  }
  return isXPatternQuestion(message)
    || isXStrategyQuestion(message)
    || isFirstPersonSocialStrategyQuestion(message)
    || isXTimingQuestion(message)
    || isSocialRecencyQuestion(message);
}

function mentionsExplicitXSurface(message: string): boolean {
  return /\b(x|twitter|tweet|tweets)\b/i.test(message) || hasExplicitHandle(message) || hasBareHandleReference(message);
}

export function buildQueryRefinementSections(
  message: string,
  toolResults: QueryRefinementToolResult[]
): string[] {
  const syncFreshnessFailure = xSyncFreshnessFailureSections(message, toolResults);
  const metricViewRecovery = xMetricViewRecoverySections(toolResults);
  if (metricViewRecovery.length > 0 && syncFreshnessFailure.length > 0) {
    return [...metricViewRecovery, ...syncFreshnessFailure];
  }
  if (metricViewRecovery.length > 0) {
    return metricViewRecovery;
  }
  if (syncFreshnessFailure.length > 0) {
    return syncFreshnessFailure;
  }
  if (isXTimingQuestion(message)) {
    const breakdowns = toolResults
      .filter((result) => result.name === "run_breakdown_query" && isRecord(result.result))
      .map((result) => objectRecord(result.result as Record<string, unknown>, "data"))
      .filter((payload): payload is Record<string, unknown> => Boolean(payload));
    const hasEngagementTiming = breakdowns.some((payload) =>
      stringValue(payload.metric) === "x_public_engagement" &&
      Array.isArray(payload.rows) &&
      payload.rows.some((row) => isRecord(row) && (row.published_hour_utc !== undefined || row.published_weekday_utc !== undefined))
    );
    const hasPostCountTiming = breakdowns.some((payload) =>
      stringValue(payload.metric) === "x_post_count" &&
      Array.isArray(payload.rows) &&
      payload.rows.some((row) => isRecord(row) && (row.published_hour_utc !== undefined || row.published_weekday_utc !== undefined))
    );
    if (hasEngagementTiming && !hasPostCountTiming) {
      return [
        "Timing-analysis refinement guidance:",
        "- You have engagement buckets, but not matching posting-volume buckets yet.",
        "- Before answering strongly, fetch `x_post_count` over the same time buckets so you can compare performance against posting frequency.",
        "- If you cannot get posting-volume buckets, answer conservatively and call the result directional."
      ];
    }
  }
  if (isXPatternQuestion(message) || isXStrategyQuestion(message) || isXNegativeStrategyQuestion(message)) {
    const latestBreakdown = [...toolResults]
      .reverse()
      .find((result) => result.name === "run_breakdown_query" && isRecord(result.result));
    if (!latestBreakdown || !isRecord(latestBreakdown.result)) {
      return [
        isXStrategyQuestion(message)
          ? "X strategy refinement guidance:"
          : isXNegativeStrategyQuestion(message)
            ? "X negative-strategy refinement guidance:"
            : "X pattern-analysis refinement guidance:",
        isXStrategyQuestion(message)
          ? "- You do not have a ranked post sample yet that can support a strong 'post more of this' recommendation."
          : isXNegativeStrategyQuestion(message)
          ? "- You do not have a post-level sample yet that can support a cautious stop-posting recommendation."
          : "- You do not have a ranked top-post set yet.",
        isXStrategyQuestion(message)
          ? "- Before recommending what to post more of, fetch a richer post-level engagement breakdown with multiple authored posts so you can ground the recommendations in recurring winners."
          : isXNegativeStrategyQuestion(message)
          ? "- Before advising what to stop or reduce, fetch a richer post-level engagement breakdown with multiple authored posts so you can separate evidence from generic caution."
          : "- Before explaining what the best-performing posts had in common, fetch a richer post-level engagement breakdown with multiple authored posts."
      ];
    }
    const payload = objectRecord(latestBreakdown.result, "data");
    const rows = Array.isArray(payload?.rows) ? payload.rows.filter(isRecord) : [];
    const strongRows = rows.filter((row) => hasReadablePostBody(row));
    if (rows.length < 3 || strongRows.length < 2) {
      return [
        isXStrategyQuestion(message)
          ? "X strategy refinement guidance:"
          : isXNegativeStrategyQuestion(message)
            ? "X negative-strategy refinement guidance:"
            : "X pattern-analysis refinement guidance:",
        isXStrategyQuestion(message)
          ? "- The current top-post set is too thin for a strong content recommendation."
          : isXNegativeStrategyQuestion(message)
            ? "- The current post sample is too thin for a strong stop-posting recommendation."
            : "- The current top-post set is too thin for a strong comparison answer.",
        isXNegativeStrategyQuestion(message)
          ? "- Before generalizing, fetch a richer post-level breakdown with multiple readable posts so you can distinguish grounded caution from one-sided winner data."
          : "- Before generalizing, fetch a richer top-post breakdown with multiple readable posts so you can compare recurring themes and contrasts."
      ];
    }
  }
  if (classifyQueryFamily(message) !== "best_post") {
    const genericRefinement = genericOpenEndedRefinementSections(message, toolResults);
    if (genericRefinement.length > 0) {
      return genericRefinement;
    }
    return [];
  }
  const latestBreakdown = [...toolResults]
    .reverse()
    .find((result) => result.name === "run_breakdown_query" && isRecord(result.result));
  if (!latestBreakdown || !isRecord(latestBreakdown.result)) {
    return [];
  }
  const payload = objectRecord(latestBreakdown.result, "data");
  const rows = Array.isArray(payload?.rows) ? payload.rows.filter(isRecord) : [];
  if (rows.length === 0) {
    return [
      "Best-post refinement guidance:",
      "- The current breakdown returned no ranked posts.",
      "- Before answering, try a richer post-level engagement breakdown again."
    ];
  }
  const strongRows = rows.filter((row) => hasReadablePostBody(row));
  if (rows.length < 3 || strongRows.length < 2) {
    return [
      "Best-post refinement guidance:",
      "- The current post ranking is too thin for a strong final answer.",
      "- If possible, continue refining before answering: request a richer breakdown with multiple ranked posts and readable body_text so you can mention runner-ups and interpretation."
    ];
  }
  return [];
}

const X_METRIC_VIEW_GUIDANCE: Record<string, { view: string; description: string }> = {
  x_public_engagement: {
    view: "queryable.vw_x_post_public_metrics",
    description: "public post engagement totals"
  },
  x_post_count: {
    view: "queryable.vw_x_authored_activity",
    description: "authored post volume"
  },
  x_comment_count: {
    view: "queryable.vw_x_authored_activity",
    description: "authored replies/comments"
  },
  x_follower_count: {
    view: "queryable.vw_x_profile_public_metrics",
    description: "profile follower snapshots"
  }
};

function xMetricViewRecoverySections(toolResults: QueryRefinementToolResult[]): string[] {
  const mismatch = latestUnsupportedMetricViewError(toolResults);
  if (!mismatch || !mismatch.metric.startsWith("x_")) {
    return [];
  }
  const guidance = X_METRIC_VIEW_GUIDANCE[mismatch.metric];
  if (!guidance) {
    return [
      "X metric/view recovery guidance:",
      `- The previous query used unsupported X metric/view pair \`${mismatch.metric}\` on \`${mismatch.view}\`.`,
      "- Call `describe_metric` for that metric before retrying so you use its declared source view and allowed dimensions.",
      `- Do not retry \`${mismatch.metric}\` on \`${mismatch.view}\`.`
    ];
  }
  return [
    "X metric/view recovery guidance:",
    `- The previous query used unsupported X metric/view pair \`${mismatch.metric}\` on \`${mismatch.view}\`.`,
    `- \`${mismatch.metric}\` belongs on \`${guidance.view}\` for ${guidance.description}.`,
    "- Call `describe_metric` if you need dimensions or time columns before retrying.",
    `- Do not retry \`${mismatch.metric}\` on \`${mismatch.view}\`; switch to \`${guidance.view}\` or choose a metric that belongs on the requested view.`
  ];
}

function latestUnsupportedMetricViewError(
  toolResults: QueryRefinementToolResult[]
): { metric: string; view: string } | undefined {
  for (const result of [...toolResults].reverse()) {
    if (!isRecord(result.result)) {
      continue;
    }
    const error = objectRecord(result.result, "error");
    const message = stringValue(error?.message) ?? stringValue(error?.code);
    if (!message) {
      continue;
    }
    const match = message.match(/unsupported_view_for_metric:([^:\s]+):([^,\s]+)/);
    if (match?.[1] && match[2]) {
      return { metric: match[1], view: match[2] };
    }
  }
  return undefined;
}

function xSyncFreshnessFailureSections(message: string, toolResults: QueryRefinementToolResult[]): string[] {
  if (!isXFreshnessSensitiveQuestion(message)) {
    return [];
  }
  const failedSync = latestFailedSyncSourceNow(toolResults);
  if (!failedSync) {
    return [];
  }
  const errorMessage = failedSync.errorMessage ? ` Error: ${failedSync.errorMessage}` : "";
  return [
    "X freshness failure guidance:",
    `- A \`sync_source_now\` call failed in this turn.${errorMessage}`,
    "- Do not present stored X rows as latest, current, same-day-fresh, or first-ever coverage after a failed refresh.",
    "- If you still answer from stored X rows, explicitly label them as local stored/synced data from before the failed refresh and explain that current provider freshness could not be verified.",
    "- For latest/current/today X ranking questions, refuse or caveat any current claim unless a later `sync_source_now` succeeds in this turn.",
    "- For first/earliest X post questions, phrase any result as the earliest synced public post, not the user's first tweet ever, unless full-history coverage was verified after a successful refresh."
  ];
}

function isXFreshnessSensitiveQuestion(message: string): boolean {
  return isSocialRecencyQuestion(message)
    || isXFirstPostQuestion(message)
    || isXPerformanceTodayQuestion(message)
    || isXCurrentChannelPerformanceQuestion(message);
}

function latestFailedSyncSourceNow(
  toolResults: QueryRefinementToolResult[]
): { errorMessage?: string } | undefined {
  for (const result of [...toolResults].reverse()) {
    if (result.name !== "sync_source_now" || !isRecord(result.result)) {
      continue;
    }
    if (stringValue(result.result.status) !== "error") {
      return undefined;
    }
    const error = objectRecord(result.result, "error");
    return { errorMessage: stringValue(error?.message) };
  }
  return undefined;
}

function genericOpenEndedRefinementSections(
  message: string,
  toolResults: QueryRefinementToolResult[]
): string[] {
  if (isCapabilityExplorationPrompt(message)) {
    const hasMetrics = toolResults.some((result) => result.name === "list_metrics" && isRecord(result.result));
    const hasViews = toolResults.some((result) => result.name === "list_queryable_views" && isRecord(result.result));
    const hasMetricDetail = toolResults.some((result) => result.name === "describe_metric" && isRecord(result.result));
    const hasViewDetail = toolResults.some((result) => result.name === "describe_queryable_view" && isRecord(result.result));
    if ((hasMetrics || hasViews) && !hasMetricDetail && !hasViewDetail) {
      return [
        "Capability-exploration refinement guidance:",
        "- You have a high-level schema inventory, but not enough detail to explain what is most useful to inspect.",
        "- Before answering, fetch at least one metric or view detail so you can explain what the user can inspect, why it matters, and how they might query it next."
      ];
    }
  }

  if (!isOpenEndedAnalysisPrompt(message)) {
    return [];
  }

  const hasSources = toolResults.some((result) => result.name === "list_sources" && isRecord(result.result));
  const hasSyncs = toolResults.some((result) => result.name === "get_recent_sync_runs" && isRecord(result.result));
  const hasMetrics = toolResults.some((result) => result.name === "list_metrics" && isRecord(result.result));
  const hasViews = toolResults.some((result) => result.name === "list_queryable_views" && isRecord(result.result));
  const hasMetricResult = toolResults.some((result) => result.name === "run_metric_query" && isRecord(result.result));
  const hasBreakdownResult = toolResults.some((result) => result.name === "run_breakdown_query" && isRecord(result.result));

  if (hasSources && !hasMetrics && !hasViews) {
    return [
      "Open-ended analysis refinement guidance:",
      "- You know which sources are connected, but not yet what metrics or views are available to analyze.",
      "- Before answering broadly, fetch metric or view coverage so you can connect source availability to questions the workspace can actually answer."
    ];
  }

  if ((hasMetrics || hasViews) && !hasSources) {
    return [
      "Open-ended analysis refinement guidance:",
      "- You know what can be queried, but not which sources are actually connected for this workspace.",
      "- Before answering broadly, fetch source coverage and freshness so you can say what is truly available versus only theoretically queryable."
    ];
  }

  if (hasSources && !hasSyncs && (hasMetrics || hasViews)) {
    return [
      "Open-ended analysis refinement guidance:",
      "- You have source and metric coverage, but not enough freshness context yet.",
      "- Before answering broadly, fetch recent sync or source-health context so you can say whether the workspace looks current and trustworthy."
    ];
  }

  if (hasSources && hasSyncs && (hasMetrics || hasViews) && !hasMetricResult && !hasBreakdownResult) {
    return [
      "Open-ended analysis refinement guidance:",
      "- You have workspace inventory and freshness context, but not yet one concrete analytical signal.",
      "- Before answering broadly, fetch at least one supporting metric or breakdown so you can say what actually stands out rather than only describing what is connected."
    ];
  }

  const latestBreakdown = [...toolResults]
    .reverse()
    .find((result) => result.name === "run_breakdown_query" && isRecord(result.result));
  if (latestBreakdown && isRecord(latestBreakdown.result)) {
    const payload = objectRecord(latestBreakdown.result, "data");
    const metric = stringValue(payload?.metric);
    const rows = Array.isArray(payload?.rows) ? payload.rows.filter(isRecord) : [];
    if (metric && rows.length <= 1) {
      return [
        "Open-ended analysis refinement guidance:",
        `- You only have a thin ranked result for ${metric}.`,
        "- Before answering broadly, fetch a richer comparison view, related source/sync context, or another supporting result so you can explain what actually stands out and why it matters."
      ];
    }
  }

  const latestMetric = [...toolResults]
    .reverse()
    .find((result) => result.name === "run_metric_query" && isRecord(result.result));
  if (latestMetric && isRecord(latestMetric.result)) {
    const payload = objectRecord(latestMetric.result, "data");
    const metric = stringValue(payload?.metric);
    const rows = Array.isArray(payload?.rows) ? payload.rows.filter(isRecord) : [];
    if (metric && rows.length > 0 && !hasSourceStatusResults(toolResults)) {
      return [
        "Open-ended analysis refinement guidance:",
        `- You have a scalar result for ${metric}, but not enough context for a strong open-ended answer yet.`,
        "- Before answering, consider fetching related source/sync context, a comparison breakdown, or a nearby metric so you can explain why the result matters instead of just restating it."
      ];
    }
  }

  return [];
}

function isOpenEndedAnalysisPrompt(message: string): boolean {
  return /\b(what stands out|what should i know|what matters|what jumps out|help me understand|analy[sz]e this|analyze this)\b/i.test(message);
}

function isCapabilityExplorationPrompt(message: string): boolean {
  return /\b(what can i inspect|what .* can i inspect|what can i query|what metrics are available|what views are available|what is available)\b/i.test(message);
}

export function buildQuerySynthesisSections(
  message: string,
  toolResults: QueryRefinementToolResult[]
): string[] {
  if (isXNegativeStrategyQuestion(message)) {
    const latestBreakdown = latestBreakdownRows(toolResults);
    const negativeStrategySections = genericXNegativeStrategySections("x_public_engagement", latestBreakdown.rows);
    if (negativeStrategySections.length > 0) {
      return negativeStrategySections;
    }
  }
  if (isXStrategyQuestion(message)) {
    const latestBreakdown = latestBreakdownRows(toolResults);
    const strategySections = genericXStrategySections("x_public_engagement", latestBreakdown.rows);
    if (strategySections.length > 0) {
      return strategySections;
    }
  }
  if (isXPatternQuestion(message)) {
    const latestBreakdown = latestBreakdownRows(toolResults);
    const patternSections = genericXPatternSections("x_public_engagement", latestBreakdown.rows);
    if (patternSections.length > 0) {
      return patternSections;
    }
  }
  const kind = classifyQueryFamily(message);
  if (kind === "best_post") {
    const latestBreakdown = latestBreakdownRows(toolResults);
    if (latestBreakdown.rows.length >= 3) {
      return [
        "Best-post final synthesis guidance:",
        "- Lead with the winning post text and its public engagement total.",
        "- Mention at least two runner-ups by rank when available.",
        "- Add one short interpretation about what likely worked across the top posts.",
        "- Prefer a conversational ranked list or bullets over a markdown table unless the user explicitly asked for tabular output.",
        "- Keep the details section concise and grounded in the returned rows."
      ];
    }
  }
  if (kind === "comment_count" && hasMetricResult(toolResults, "x_comment_count")) {
    return [
      "Comment-count final synthesis guidance:",
      "- Lead with the total comment/reply count in one sentence.",
      "- Briefly explain that this reflects authored replies/comments present in the synced X timeline.",
      "- Keep the answer conversational and avoid table-heavy formatting unless the user explicitly asked for it.",
      "- Keep caveats concise."
    ];
  }
  if (kind === "follower_count" && hasMetricResult(toolResults, "x_follower_count")) {
    return [
      "Follower-count final synthesis guidance:",
      "- Lead with the follower total in one sentence.",
      "- State that it comes from the latest public X profile metrics snapshot for the connected account.",
      "- Keep the answer conversational and avoid table-heavy formatting unless the user explicitly asked for it.",
      "- Keep the details section concise."
    ];
  }
  if (kind === "post_count" && hasMetricResult(toolResults, "x_post_count")) {
    return [
      "Post-count final synthesis guidance:",
      "- Lead with the authored post total in one sentence.",
      "- State that it reflects authored posts present in the synced X timeline.",
      "- Keep the answer conversational and avoid table-heavy formatting unless the user explicitly asked for it.",
      "- Keep caveats concise."
    ];
  }
  if (kind === "revenue_source" && hasBreakdownResult(toolResults, "recognized_revenue")) {
    return [
      "Revenue-source final synthesis guidance:",
      "- Lead with the top revenue source in one sentence.",
      "- Mention up to two runner-up sources when available.",
      "- If the breakdown is empty, explain that directly and suggest checking source/sync status.",
      "- Keep the answer conversational."
    ];
  }
  if (kind === "recognized_revenue" && hasMetricResult(toolResults, "recognized_revenue")) {
    return [
      "Revenue-total final synthesis guidance:",
      "- Lead with the total recognized revenue in one sentence.",
      "- Mention that Stripe is the first-phase revenue authority.",
      "- Keep the answer conversational."
    ];
  }
  if (kind === "site_visitors" && hasMetricResult(toolResults, "site_visitors")) {
    return [
      "Visitor-count final synthesis guidance:",
      "- Lead with the total visitor count in one sentence.",
      "- Mention that GA4 is the first-phase traffic authority.",
      "- Keep the answer conversational."
    ];
  }
  if (kind === "visitor_channel_breakdown" && hasBreakdownResult(toolResults, "site_visitors")) {
    return [
      "Traffic-channel final synthesis guidance:",
      "- Lead with the strongest traffic source in one sentence.",
      "- Mention up to two runner-up traffic sources when available.",
      "- Add one short interpretation about what the top traffic sources suggest.",
      "- Keep the answer conversational."
    ];
  }
  if (kind === "signup_channel_breakdown" && hasBreakdownResult(toolResults, "signup_count")) {
    return [
      "Signup-channel final synthesis guidance:",
      "- Lead with the strongest signup channel in one sentence.",
      "- Mention up to two runner-up channels when available.",
      "- Add one short interpretation about what the top signup sources suggest.",
      "- Keep the answer conversational."
    ];
  }
  if (kind === "conversion_channel_breakdown" && hasBreakdownResult(toolResults, "site_conversion_rate")) {
    return [
      "Conversion-channel final synthesis guidance:",
      "- Lead with the strongest converting channel in one sentence.",
      "- Mention up to two runner-up channels when available.",
      "- Add one short interpretation about what the top converting channels suggest.",
      "- Keep the answer conversational."
    ];
  }
  if (kind === "signup_count" && hasMetricResult(toolResults, "signup_count")) {
    return [
      "Signup-count final synthesis guidance:",
      "- Lead with the signup total in one sentence.",
      "- Mention that PostHog signups are the first-phase signup authority.",
      "- Keep the answer conversational."
    ];
  }
  if (kind === "site_conversion_rate" && hasMetricResult(toolResults, "site_conversion_rate")) {
    return [
      "Conversion-rate final synthesis guidance:",
      "- Lead with the conversion rate in one sentence.",
      "- Mention that it uses first-phase GA4 visitors and PostHog signups.",
      "- Keep the answer conversational."
    ];
  }
  if (kind === "source_status" && hasSourceStatusResults(toolResults)) {
    return [
      "Source-status final synthesis guidance:",
      "- Lead with the connection state in one sentence.",
      "- Mention the latest sync status when available.",
      "- Keep the answer conversational and concrete."
    ];
  }
  if (kind === "other") {
    const generic = genericSynthesisSections(toolResults);
    if (generic.length > 0) {
      return generic;
    }
  }
  return [];
}

export function classifyQueryFamily(message: string): QueryFamily {
  if (
    /\b(best|worst)\s+times?\b/i.test(message) ||
    /\bwhen\b.*\b(tweet|tweets|post|posts)\b/i.test(message)
  ) {
    return "other";
  }
  if (/\b(best|top|most popular)\b.*\b(tweet|tweets|post|posts)\b/i.test(message) || /\b(tweet|tweets|post|posts)\b.*\b(best|top|most popular)\b/i.test(message)) {
    return "best_post";
  }
  if (/\bconnected sources?\b/i.test(message) || /\bwhat sources\b.*\bconnected\b/i.test(message) || /\b(last sync|sync status|connected)\b/i.test(message)) {
    return "source_status";
  }
  if (/\b(source|channel|provider)\b.*\brevenue\b/i.test(message) || /\brevenue\b.*\b(source|channel|provider)\b/i.test(message)) {
    return "revenue_source";
  }
  if (
    /\bhow much revenue\b/i.test(message) ||
    /\bwhat revenue did\b/i.test(message) ||
    /\brecognized revenue\b/i.test(message) ||
    /\brevenue this (month|week|quarter|year)\b/i.test(message) ||
    /\btell me about revenue\b/i.test(message) ||
    /\brevenue overview\b/i.test(message) ||
    /\brevenue total\b/i.test(message)
  ) {
    return "recognized_revenue";
  }
  if (/\bvisitors?\b|\btraffic\b|\busers?\b/i.test(message)) {
    if (/\b(visitors?|traffic|users?)\b.*\b(channels?|sources?|campaigns?)\b/i.test(message) || /\b(channels?|sources?|campaigns?)\b.*\b(visitors?|traffic|users?)\b/i.test(message)) {
      return "visitor_channel_breakdown";
    }
    return "site_visitors";
  }
  if (/\b(signups?|signup)\b.*\b(channels?|sources?|campaigns?)\b/i.test(message) || /\b(channels?|sources?|campaigns?)\b.*\b(signups?|signup)\b/i.test(message)) {
    return "signup_channel_breakdown";
  }
  if (/\b(conversion|convert(?:s|ing)?)\b.*\b(channels?|sources?|campaigns?)\b/i.test(message) || /\b(channels?|sources?|campaigns?)\b.*\b(conversion|convert(?:s|ing)?)\b/i.test(message)) {
    return "conversion_channel_breakdown";
  }
  if (/\bsignups?\b/i.test(message)) {
    return "signup_count";
  }
  if (/\bconversion\b/i.test(message)) {
    return "site_conversion_rate";
  }
  if (/\bhow many\b.*\b(tweet|tweets|post|posts)\b/i.test(message) || /\b(tweet|tweets|post|posts)\b.*\b(count|made|have i made)\b/i.test(message)) {
    return "post_count";
  }
  if (/\bcomments?\b/i.test(message) || /\brepl(?:y|ies)\b/i.test(message)) {
    return "comment_count";
  }
  if (/\bfollowers?\b/i.test(message)) {
    return "follower_count";
  }
  return "other";
}

const FIRST_PERSON_RE = /\b(my|i|i['’]?m|i['’]?ve|ive|i have|me|our)\b/i;
const X_METRIC_RE =
  /\b(tweet|tweets|post|posts|followers?|following|comments?|repl(?:y|ies)|engaged|engagement|engagements|interactions?|likes?)\b/i;

function hasReadablePostBody(row: Record<string, unknown>): boolean {
  const text = stringValue(row.body_text);
  if (!text) {
    return false;
  }
  return !/^https?:\/\/\S+$/i.test(text.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function latestBreakdownRows(toolResults: QueryRefinementToolResult[]): { rows: Record<string, unknown>[] } {
  const latestBreakdown = [...toolResults]
    .reverse()
    .find((result) => result.name === "run_breakdown_query" && isRecord(result.result));
  if (!latestBreakdown || !isRecord(latestBreakdown.result)) {
    return { rows: [] };
  }
  const payload = objectRecord(latestBreakdown.result, "data");
  return {
    rows: Array.isArray(payload?.rows) ? payload.rows.filter(isRecord) : []
  };
}

function hasMetricResult(toolResults: QueryRefinementToolResult[], metric: string): boolean {
  return [...toolResults].reverse().some((result) => {
    if (result.name !== "run_metric_query" || !isRecord(result.result)) {
      return false;
    }
    const payload = objectRecord(result.result, "data");
    return stringValue(payload?.metric) === metric;
  });
}

function hasBreakdownResult(toolResults: QueryRefinementToolResult[], metric: string): boolean {
  return [...toolResults].reverse().some((result) => {
    if (result.name !== "run_breakdown_query" || !isRecord(result.result)) {
      return false;
    }
    const payload = objectRecord(result.result, "data");
    return stringValue(payload?.metric) === metric;
  });
}

function hasSourceStatusResults(toolResults: QueryRefinementToolResult[]): boolean {
  const toolNames = new Set(toolResults.map((result) => result.name));
  return toolNames.has("list_sources") || toolNames.has("get_recent_sync_runs");
}

function genericSynthesisSections(toolResults: QueryRefinementToolResult[]): string[] {
  const combinedTimingGuidance = genericCombinedTimingSections(toolResults);
  if (combinedTimingGuidance.length > 0) {
    return combinedTimingGuidance;
  }
  const multiSignalGuidance = genericMultiSignalSections(toolResults);
  if (multiSignalGuidance.length > 0) {
    return multiSignalGuidance;
  }
  const latestBreakdown = [...toolResults]
    .reverse()
    .find((result) => result.name === "run_breakdown_query" && isRecord(result.result));
  if (latestBreakdown && isRecord(latestBreakdown.result)) {
    const payload = objectRecord(latestBreakdown.result, "data");
    const metric = stringValue(payload?.metric);
    const rows = Array.isArray(payload?.rows) ? payload.rows.filter(isRecord) : [];
    if (metric && rows.length > 0) {
      const timingGuidance = genericTimingBreakdownSections(metric, rows);
      if (timingGuidance.length > 0) {
        return timingGuidance;
      }
      const xPatternGuidance = genericXPatternSections(metric, rows);
      if (xPatternGuidance.length > 0) {
        return xPatternGuidance;
      }
      const top = genericBreakdownRowSummary(rows[0], metric);
      const runnerUp = rows[1] ? genericBreakdownRowSummary(rows[1], metric) : undefined;
      const pattern = genericBreakdownPattern(rows, metric);
      const sourceContext = genericSourceContextSummary(toolResults);
      return [
        "Generic breakdown final synthesis guidance:",
        `- You have ranked rows for ${metric}.`,
        top ? `- Top row: ${top}.` : undefined,
        runnerUp ? `- Runner-up: ${runnerUp}.` : undefined,
        pattern ? `- Pattern: ${pattern}.` : undefined,
        sourceContext ? `- Source context: ${sourceContext}.` : undefined,
        "- Lead with the strongest takeaway in one sentence, not just the top row label.",
        "- Explain why that takeaway matters in plain analyst language before listing details.",
        "- Mention up to two runner-ups when they add context.",
        "- Add one short grounded interpretation if the top row is clearly ahead or if the top rows are close together.",
        "- Cite the strongest concrete evidence row before moving into caveats or next steps.",
        "- If source context materially affects trust, include one short freshness or source-health caveat.",
        "- End with the next useful question or drilldown when the prompt is open-ended.",
        "- Keep the answer conversational and avoid repeating raw tool names."
      ].filter((value): value is string => Boolean(value));
    }
  }

  const latestMetric = [...toolResults]
    .reverse()
    .find((result) => result.name === "run_metric_query" && isRecord(result.result));
  if (latestMetric && isRecord(latestMetric.result)) {
    const payload = objectRecord(latestMetric.result, "data");
    const metric = stringValue(payload?.metric);
    const rows = Array.isArray(payload?.rows) ? payload.rows.filter(isRecord) : [];
    if (metric && rows.length > 0) {
      const metricValue = genericMetricValue(rows[0], metric);
      const sourceContext = genericSourceContextSummary(toolResults);
      return [
        "Generic metric final synthesis guidance:",
        `- You have a direct metric result for ${metric}.`,
        metricValue ? `- Metric result: ${metric}=${metricValue}.` : undefined,
        sourceContext ? `- Source context: ${sourceContext}.` : undefined,
        "- Lead with the main takeaway in one sentence, using the metric value rather than naming the metric mechanically.",
        "- Briefly explain why the result matters or what it says about the workspace before adding supporting detail.",
        "- Mention the source authority or caveat if it materially affects interpretation.",
        "- If the prompt is broad or exploratory, offer the next most useful follow-up question.",
        "- Keep the answer conversational and avoid repeating raw tool names."
      ].filter((value): value is string => Boolean(value));
    }
  }

  const workspaceOverview = genericWorkspaceOverviewSections(toolResults);
  if (workspaceOverview.length > 0) {
    return workspaceOverview;
  }

  const capabilityOverview = genericCapabilityOverviewSections(toolResults);
  if (capabilityOverview.length > 0) {
    return capabilityOverview;
  }

  return [];
}

function genericMultiSignalSections(toolResults: QueryRefinementToolResult[]): string[] {
  const metricSignals = [...toolResults]
    .filter((result) => result.name === "run_metric_query" && isRecord(result.result))
    .map((result) => objectRecord(result.result as Record<string, unknown>, "data"))
    .filter((payload): payload is Record<string, unknown> => Boolean(payload))
    .map((payload) => {
      const metric = stringValue(payload.metric);
      const rows = Array.isArray(payload.rows) ? payload.rows.filter(isRecord) : [];
      const value = metric && rows[0] ? genericMetricValue(rows[0], metric) : undefined;
      return metric && value ? `${metric}=${value}` : undefined;
    })
    .filter((value): value is string => Boolean(value));

  const breakdownSignals = [...toolResults]
    .filter((result) => result.name === "run_breakdown_query" && isRecord(result.result))
    .map((result) => objectRecord(result.result as Record<string, unknown>, "data"))
    .filter((payload): payload is Record<string, unknown> => Boolean(payload))
    .map((payload) => {
      const metric = stringValue(payload.metric);
      const rows = Array.isArray(payload.rows) ? payload.rows.filter(isRecord) : [];
      if (!metric || rows.length === 0) {
        return undefined;
      }
      const top = genericBreakdownRowSummary(rows[0], metric);
      return top ? `${metric}: ${top}` : undefined;
    })
    .filter((value): value is string => Boolean(value));

  const signals = [...new Set([...metricSignals, ...breakdownSignals])];
  if (signals.length < 2) {
    return [];
  }

  const sourceContext = genericSourceContextSummary(toolResults);
  const errorSummary = summarizeRecoverableToolErrors(toolResults);
  return [
    "Generic multi-signal synthesis guidance:",
    `- Signals available: ${signals.slice(0, 4).join("; ")}.`,
    sourceContext ? `- Source context: ${sourceContext}.` : undefined,
    errorSummary ? `- Recoverable query issues: ${errorSummary}.` : undefined,
    "- For this broad prompt, combine multiple signals instead of overfitting to just the last metric or breakdown returned.",
    "- If one supporting query failed but other strong signals succeeded, do not let the failure dominate the answer; mention it briefly only as a caveat.",
    "- Lead with the strongest cross-workspace takeaway, then support it with one or two concrete signals.",
    "- If business signals like revenue, traffic, signups, or conversion are present, prefer them over source-quality caveats in the lead unless the data is clearly unusable.",
    "- Do not open with fixture/test caveats when meaningful business signals are available; surface the caveat after the main business takeaway.",
    "- If both business and social or operational signals are present, mention the most relevant signal from each side when it helps the answer.",
    "- Keep source-quality caveats in the answer, but place them after the main takeaway unless they completely invalidate the result.",
    "- End with one or two concrete next questions only if they build naturally from the combined picture."
  ].filter((value): value is string => Boolean(value));
}

function summarizeRecoverableToolErrors(toolResults: QueryRefinementToolResult[]): string | undefined {
  const errors = toolResults
    .map((result) => {
      if (!isRecord(result.result)) {
        return undefined;
      }
      const status = stringValue(result.result.status);
      if (status !== "error") {
        return undefined;
      }
      const error = objectRecord(result.result, "error");
      const code = stringValue(error?.code);
      const message = stringValue(error?.message);
      return code ?? message;
    })
    .filter((value): value is string => Boolean(value));
  if (errors.length === 0) {
    return undefined;
  }
  return [...new Set(errors)].slice(0, 2).join(", ");
}

function genericCombinedTimingSections(toolResults: QueryRefinementToolResult[]): string[] {
  const breakdowns = [...toolResults]
    .filter((result) => result.name === "run_breakdown_query" && isRecord(result.result))
    .map((result) => objectRecord(result.result as Record<string, unknown>, "data"))
    .filter((payload): payload is Record<string, unknown> => Boolean(payload));
  const engagement = breakdowns.find((payload) => stringValue(payload.metric) === "x_public_engagement");
  const postCount = breakdowns.find((payload) => stringValue(payload.metric) === "x_post_count");
  if (!engagement || !postCount) {
    return [];
  }
  const engagementRows = Array.isArray(engagement.rows) ? engagement.rows.filter(isRecord) : [];
  const postRows = Array.isArray(postCount.rows) ? postCount.rows.filter(isRecord) : [];
  const hasTimingBuckets =
    engagementRows.some((row) => row.published_hour_utc !== undefined || row.published_weekday_utc !== undefined) &&
    postRows.some((row) => row.published_hour_utc !== undefined || row.published_weekday_utc !== undefined);
  if (!hasTimingBuckets) {
    return [];
  }
  const topEngagementHour = engagementRows.find((row) => row.published_hour_utc !== undefined);
  const topVolumeHour = postRows.find((row) => row.published_hour_utc !== undefined);
  const topEngagementDay = engagementRows.find((row) => row.published_weekday_utc !== undefined);
  const topVolumeDay = postRows.find((row) => row.published_weekday_utc !== undefined);
  return [
    "Timing-analysis synthesis guidance:",
    topEngagementHour ? `- Highest engagement hour bucket: hour ${stringValue(topEngagementHour.published_hour_utc) ?? String(topEngagementHour.published_hour_utc)} (${genericMetricValue(topEngagementHour, "x_public_engagement") ?? "?"}).` : undefined,
    topVolumeHour ? `- Highest posting-volume hour bucket: hour ${stringValue(topVolumeHour.published_hour_utc) ?? String(topVolumeHour.published_hour_utc)} (${genericMetricValue(topVolumeHour, "x_post_count") ?? "?"} posts).` : undefined,
    topEngagementDay ? `- Highest engagement weekday bucket: day ${stringValue(topEngagementDay.published_weekday_utc) ?? String(topEngagementDay.published_weekday_utc)} (${genericMetricValue(topEngagementDay, "x_public_engagement") ?? "?"}).` : undefined,
    topVolumeDay ? `- Highest posting-volume weekday bucket: day ${stringValue(topVolumeDay.published_weekday_utc) ?? String(topVolumeDay.published_weekday_utc)} (${genericMetricValue(topVolumeDay, "x_post_count") ?? "?"} posts).` : undefined,
    "- Compare engagement buckets against posting-volume buckets before claiming a slot is truly the best time to post.",
    "- If the same bucket leads both engagement and posting volume, say that the signal may partly reflect frequency rather than per-post quality.",
    "- Keep the answer directional unless the evidence clearly supports a stronger claim."
  ].filter((value): value is string => Boolean(value));
}

function genericTimingBreakdownSections(metric: string, rows: Record<string, unknown>[]): string[] {
  if (!["x_public_engagement", "x_post_count"].includes(metric)) {
    return [];
  }
  const hasHour = rows.some((row) => row.published_hour_utc !== undefined);
  const hasWeekday = rows.some((row) => row.published_weekday_utc !== undefined);
  if (!hasHour && !hasWeekday) {
    return [];
  }
  const hourRows = rows.filter((row) => row.published_hour_utc !== undefined).slice(0, 3);
  const weekdayRows = rows.filter((row) => row.published_weekday_utc !== undefined).slice(0, 3);
  return [
    "Timing-analysis synthesis guidance:",
    hasHour ? `- Top hour buckets: ${hourRows.map((row) => `hour ${stringValue(row.published_hour_utc) ?? String(row.published_hour_utc)} (${genericMetricValue(row, metric) ?? "?"})`).join("; ")}.` : undefined,
    hasWeekday ? `- Top weekday buckets: ${weekdayRows.map((row) => `day ${stringValue(row.published_weekday_utc) ?? String(row.published_weekday_utc)} (${genericMetricValue(row, metric) ?? "?"})`).join("; ")}.` : undefined,
    "- If you have only engagement totals, say the pattern is directional and may reflect posting frequency rather than per-post quality.",
    "- If you also have posting-volume buckets, compare them before making a strong claim about the best time.",
    "- Keep the answer grounded and avoid overstating statistical confidence."
  ].filter((value): value is string => Boolean(value));
}

function genericXPatternSections(metric: string, rows: Record<string, unknown>[]): string[] {
  if (metric !== "x_public_engagement") {
    return [];
  }
  const postRows = rows.filter((row) => stringValue(row.body_text) || stringValue(row.post_url) || stringValue(row.x_post_id));
  if (postRows.length < 2) {
    return [];
  }
  const topRows = postRows.slice(0, 5).map((row) => genericBreakdownRowSummary(row, metric)).filter((value): value is string => Boolean(value));
  return [
    "X pattern-analysis synthesis guidance:",
    topRows.length ? `- Top posts include: ${topRows.join("; ")}.` : undefined,
    "- Compare the top posts for recurring themes, tone, format, or reply-versus-original-post patterns.",
    "- Mention one or two concrete shared traits and one contrast if a standout post succeeded for a different reason.",
    "- Keep the answer conversational and grounded in the returned posts rather than turning it into generic social advice."
  ].filter((value): value is string => Boolean(value));
}

function genericXStrategySections(metric: string, rows: Record<string, unknown>[]): string[] {
  if (metric !== "x_public_engagement") {
    return [];
  }
  const postRows = rows.filter((row) => stringValue(row.body_text) || stringValue(row.post_url) || stringValue(row.x_post_id));
  if (postRows.length < 2) {
    return [];
  }
  const topRows = postRows.slice(0, 5).map((row) => genericBreakdownRowSummary(row, metric)).filter((value): value is string => Boolean(value));
  return [
    "X strategy synthesis guidance:",
    topRows.length ? `- Top posts include: ${topRows.join("; ")}.` : undefined,
    "- Use the strongest recurring traits across the top posts to recommend what the user should post more of.",
    "- Give 2-3 concrete content recommendations, not just a theme summary.",
    "- Keep the recommendations grounded in the returned top posts and explicitly mention uncertainty when the sample is small."
  ].filter((value): value is string => Boolean(value));
}

function genericXNegativeStrategySections(metric: string, rows: Record<string, unknown>[]): string[] {
  if (metric !== "x_public_engagement") {
    return [];
  }
  const postRows = rows.filter((row) => stringValue(row.body_text) || stringValue(row.post_url) || stringValue(row.x_post_id));
  if (postRows.length < 2) {
    return [];
  }
  const topRows = postRows.slice(0, 5).map((row) => genericBreakdownRowSummary(row, metric)).filter((value): value is string => Boolean(value));
  return [
    "X negative-strategy synthesis guidance:",
    topRows.length ? `- Strong posts in the current sample include: ${topRows.join("; ")}.` : undefined,
    "- If the available evidence is mostly top-performing posts, do not claim that the data directly proves what to stop posting.",
    "- Separate grounded observations about what performs well from more general cautionary advice about what may be lower-signal or worth reducing.",
    "- Give 2-3 concrete 'stop or do less of' recommendations only when they clearly follow from the returned posts; otherwise frame them as cautious hypotheses.",
    "- Keep the answer conversational and explicit about uncertainty when the evidence is one-sided."
  ].filter((value): value is string => Boolean(value));
}

function genericMetricValue(row: Record<string, unknown>, metric: string): string | undefined {
  const value = row[metric];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function genericBreakdownRowSummary(row: Record<string, unknown>, metric: string): string | undefined {
  const label = genericBreakdownLabel(row);
  const value = genericMetricValue(row, metric);
  if (label && value) {
    return `${label} at ${metric}=${value}`;
  }
  if (label) {
    return label;
  }
  if (value) {
    return `${metric}=${value}`;
  }
  return undefined;
}

function genericBreakdownLabel(row: Record<string, unknown>): string | undefined {
  const provider = stringValue(row.provider);
  const currency = stringValue(row.currency);
  if (provider || currency) {
    return [provider, currency].filter(Boolean).join(" / ");
  }
  const utmSource = stringValue(row.utm_source);
  const utmMedium = stringValue(row.utm_medium);
  const utmCampaign = stringValue(row.utm_campaign);
  if (utmSource || utmMedium || utmCampaign) {
    return [utmSource, utmMedium, utmCampaign].filter(Boolean).join(" / ");
  }
  const country = stringValue(row.country);
  const landingPage = stringValue(row.landing_page);
  if (country || landingPage) {
    return [country, landingPage].filter(Boolean).join(" / ");
  }
  return stringValue(row.body_text) ?? stringValue(row.post_url) ?? stringValue(row.x_post_id);
}

function genericBreakdownPattern(rows: Record<string, unknown>[], metric: string): string | undefined {
  if (rows.length < 2) {
    return undefined;
  }
  const first = Number(genericMetricValue(rows[0], metric));
  const second = Number(genericMetricValue(rows[1], metric));
  if (!Number.isFinite(first) || !Number.isFinite(second) || first <= 0 || second <= 0) {
    return undefined;
  }
  if (first >= second * 2) {
    return "the winner is clearly ahead of the next row";
  }
  return "the top rows are relatively close together";
}

function genericSourceContextSummary(toolResults: QueryRefinementToolResult[]): string | undefined {
  const sourcesEnvelope = [...toolResults]
    .reverse()
    .find((result) => result.name === "list_sources" && isRecord(result.result));
  if (!sourcesEnvelope || !isRecord(sourcesEnvelope.result)) {
    return undefined;
  }
  const sourcesPayload = objectRecord(sourcesEnvelope.result, "data");
  const sources = Array.isArray(sourcesPayload?.sources) ? sourcesPayload.sources.filter(isRecord) : [];
  if (sources.length === 0) {
    return undefined;
  }

  const syncEnvelope = [...toolResults]
    .reverse()
    .find((result) => result.name === "get_recent_sync_runs" && isRecord(result.result));
  const syncPayload = syncEnvelope && isRecord(syncEnvelope.result)
    ? objectRecord(syncEnvelope.result, "data")
    : undefined;
  const syncRuns = Array.isArray(syncPayload?.syncRuns) ? syncPayload.syncRuns.filter(isRecord) : [];

  const syncedFacts = summarizeSyncedSourceFacts(sources, syncRuns);
  if (syncedFacts.length > 0) {
    return `${syncedFacts.join("; ")}; do not describe a source as never synced when last_synced_at or sync runs are present`;
  }
  const sourceLabels = sources
    .slice(0, 4)
    .map(sourceLabel)
    .filter((value) => value !== "unknown");
  return sourceLabels.length ? sourceLabels.join("; ") : undefined;
}

function genericCapabilityOverviewSections(toolResults: QueryRefinementToolResult[]): string[] {
  const metricEnvelope = [...toolResults]
    .reverse()
    .find((result) => result.name === "describe_metric" && isRecord(result.result));
  const viewEnvelope = [...toolResults]
    .reverse()
    .find((result) => result.name === "describe_queryable_view" && isRecord(result.result));
  const metricsListEnvelope = [...toolResults]
    .reverse()
    .find((result) => result.name === "list_metrics" && isRecord(result.result));

  const metric = metricEnvelope && isRecord(metricEnvelope.result)
    ? objectRecord(metricEnvelope.result, "data")?.metric
    : undefined;
  const view = viewEnvelope && isRecord(viewEnvelope.result)
    ? objectRecord(viewEnvelope.result, "data")?.view
    : undefined;
  const metricsData = metricsListEnvelope && isRecord(metricsListEnvelope.result)
    ? objectRecord(metricsListEnvelope.result, "data")
    : undefined;
  const metricsList = Array.isArray(metricsData?.metrics) ? metricsData.metrics.filter(isRecord) : [];
  const metricIds = metricsList
    .map((item) => stringValue(item.id))
    .filter((value): value is string => Boolean(value))
    .slice(0, 6);

  if (!isRecord(metric) && !isRecord(view) && metricIds.length === 0) {
    return [];
  }

  return [
    "Generic capability-overview synthesis guidance:",
    isRecord(metric) && stringValue(metric.id)
      ? `- Metric available: ${stringValue(metric.id)}${stringValue(metric.source_view) ? ` from ${stringValue(metric.source_view)}` : ""}.`
      : undefined,
    isRecord(metric) && Array.isArray(metric.allowed_dimensions)
      ? `- Allowed dimensions include: ${metric.allowed_dimensions.filter((value): value is string => typeof value === "string").slice(0, 4).join(", ")}.`
      : undefined,
    isRecord(view) && stringValue(view.id)
      ? `- Queryable view: ${stringValue(view.id)}${stringValue(view.row_grain) ? ` at grain ${stringValue(view.row_grain)}` : ""}.`
      : undefined,
    metricIds.length ? `- Metrics you can inspect include: ${metricIds.join(", ")}.` : undefined,
    "- Lead with the most useful thing the user can inspect first, not a raw inventory dump.",
    "- Explain why that capability matters in plain analyst language.",
    "- Then mention one or two other useful things they can inspect next.",
    "- End with one or two concrete next questions they could ask.",
    "- Keep the answer conversational and avoid repeating raw tool names."
  ].filter((value): value is string => Boolean(value));
}

function genericWorkspaceOverviewSections(toolResults: QueryRefinementToolResult[]): string[] {
  const sourcesEnvelope = [...toolResults]
    .reverse()
    .find((result) => result.name === "list_sources" && isRecord(result.result));
  const metricsEnvelope = [...toolResults]
    .reverse()
    .find((result) => result.name === "list_metrics" && isRecord(result.result));
  const syncEnvelope = [...toolResults]
    .reverse()
    .find((result) => result.name === "get_recent_sync_runs" && isRecord(result.result));
  if (!sourcesEnvelope || !isRecord(sourcesEnvelope.result)) {
    return [];
  }
  const sourcesPayload = objectRecord(sourcesEnvelope.result, "data");
  const metricsPayload = metricsEnvelope && isRecord(metricsEnvelope.result)
    ? objectRecord(metricsEnvelope.result, "data")
    : undefined;
  const syncPayload = syncEnvelope && isRecord(syncEnvelope.result)
    ? objectRecord(syncEnvelope.result, "data")
    : undefined;
  const sources = Array.isArray(sourcesPayload?.sources) ? sourcesPayload.sources.filter(isRecord) : [];
  const metricIds = Array.isArray(metricsPayload?.metrics)
    ? metricsPayload.metrics
        .filter(isRecord)
        .map((metric) => stringValue(metric.id))
        .filter((value): value is string => Boolean(value))
    : [];
  const syncRuns = Array.isArray(syncPayload?.syncRuns) ? syncPayload.syncRuns.filter(isRecord) : [];
  if (sources.length === 0 && metricIds.length === 0) {
    return [];
  }

  const sourceSnapshot = sources
    .slice(0, 6)
    .map((source) => {
      const provider = stringValue(source.provider);
      const connectionName = stringValue(source.connection_name ?? source.connectionName);
      if (!provider) {
        return undefined;
      }
      return connectionName ? `${provider} (${connectionName})` : provider;
    })
    .filter((value): value is string => Boolean(value));
  const syntheticSources = sourceSnapshot.filter((value) => /\b(fixture|test|demo|example|sample|mock|export check)\b/i.test(value));
  const syncSummary = summarizeWorkspaceSyncRuns(syncRuns);
  const syncedSourceFacts = summarizeSyncedSourceFacts(sources, syncRuns);

  return [
    "Generic workspace-overview synthesis guidance:",
    sources.length ? `- Connected sources: ${sources.length}.` : undefined,
    sourceSnapshot.length ? `- Source snapshot: ${sourceSnapshot.join("; ")}.` : undefined,
    syntheticSources.length ? `- Likely synthetic/test sources: ${syntheticSources.join("; ")}.` : undefined,
    syncSummary ? `- Recent sync health: ${syncSummary}.` : undefined,
    syncedSourceFacts.length ? `- Synced source evidence: ${syncedSourceFacts.join("; ")}.` : undefined,
    syncedSourceFacts.length ? "- Do not describe a source as never synced when last_synced_at or sync runs are present." : undefined,
    metricIds.length ? `- Metrics available include: ${metricIds.slice(0, 6).join(", ")}.` : undefined,
    "- Lead with the strongest workspace-level takeaway first, not just the count of sources.",
    "- Explain what appears production-like, incomplete, or synthetic in plain analyst language.",
    "- Then tell the user what kinds of questions this workspace is now ready to answer.",
    "- End with one or two concrete next questions the user can ask."
  ].filter((value): value is string => Boolean(value));
}

function summarizeWorkspaceSyncRuns(syncRuns: Record<string, unknown>[]): string | undefined {
  if (syncRuns.length === 0) {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const run of syncRuns) {
    const status = stringValue(run.status);
    if (!status) {
      continue;
    }
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  if (counts.size === 0) {
    return undefined;
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
}

function summarizeSyncedSourceFacts(
  sources: Record<string, unknown>[],
  syncRuns: Record<string, unknown>[]
): string[] {
  return sources
    .slice(0, 6)
    .map((source) => {
      const sourceId = stringValue(source.id);
      const lastSyncedAt = stringValue(source.last_synced_at ?? source.lastSyncedAt);
      const latestSync = sourceId
        ? syncRuns.find((run) => stringValue(run.source_id ?? run.sourceId) === sourceId)
        : undefined;
      if (!lastSyncedAt && !latestSync) {
        return undefined;
      }
      const label = sourceLabel(source);
      const syncStatus = stringValue(latestSync?.status);
      const finishedAt = stringValue(latestSync?.finished_at ?? latestSync?.finishedAt);
      const loaded = latestSync ? numericTextValue(latestSync.records_loaded ?? latestSync.recordsLoaded) : undefined;
      const parts = [
        lastSyncedAt ? `has last_synced_at=${lastSyncedAt}` : "has sync-run history",
        syncStatus ? `latest sync ${syncStatus}` : undefined,
        finishedAt ? `finished_at=${finishedAt}` : undefined,
        loaded ? `records_loaded=${loaded}` : undefined
      ].filter((value): value is string => Boolean(value));
      return `${label} ${parts.join(", ")}`;
    })
    .filter((value): value is string => Boolean(value));
}

function sourceLabel(source: Record<string, unknown>): string {
  const provider = stringValue(source.provider) ?? "unknown";
  const connectionName = stringValue(source.connection_name ?? source.connectionName);
  return connectionName ? `${provider} (${connectionName})` : provider;
}

function numericTextValue(value: unknown): string | undefined {
  const parsed = numberValue(value);
  return parsed === undefined ? undefined : String(parsed);
}
