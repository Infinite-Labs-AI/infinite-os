# Local Meta publishing

The maintainer `infinite local meta` commands and raw operator actions target the local engine. The signed desktop's shared-account publishing uses its cloud action ledger; this does not re-enable its retired local Meta connection lane.

Every local campaign, ad set, creative and ad create requires a caller-chosen `clientToken` (`--client-token` in the CLI). Keep that token for the same operation. A completed repeat returns the known entity ID only when actor, entity, immutable input and current source/account/credential binding match. Legacy local dedup rows without this proof refuse for reconciliation. A pending or uncertain repeat refuses without another provider write. Never substitute a new token to retry an uncertain operation. A new token means a new intended create. Creatives have no delivery status; campaigns, ad sets and ads are created paused.

When creating an ad from an existing creative, the engine verifies the creative account, tracking tags and destination with one bounded provider read. A recent successful creative in the same explicit launch, actor and credential/Page binding supplies that proof without another read. Existing post creatives whose destinations cannot be verified refuse before the ad write.

A local create snapshots the source and active credential together, checks the account match, and uses that same token/version/Page throughout. Active linked OAuth tokens are captured in the same query. Expired or revoked OAuth tokens must be refreshed or reconnected separately; a create never refreshes a token midway through publishing.

Local creative publishing verifies the posting Page's Instagram association. It forwards a verified identity, or sends Page-only when all associations are absent. Malformed/ambiguous responses refuse before creation. An explicit `instagramUserId` must match. The optional `launchId` (`--launch-id`) shares ten-minute identity evidence between creatives in one batch, scoped to workspace, source, opaque actor, credential version and Page. The first identity remains pinned across refresh; a changed association requires a new confirmed launch. Without `launchId`, the `clientToken` scopes the evidence to the individual operation. This does not introduce batch parent-read skipping or a final listing for independent CLI actions.

Supply a clean HTTP(S) website `linkUrl`, or destinations in `assetFeedSpec.link_urls`. Media URLs are never treated as destinations. Omitted `urlTags` receive Facebook paid-social tracking with campaign/ad-set ID macros and `utm_content={{ad.name}}`. Explicit tags are validated; destination URLs with existing tracking parameters refuse. Ad names must be safe unchanged as `utm_content`. Owned short-link hosts (`go.infinite.fast` by default, plus the operator’s `SHORT_LINK_HOST` / `SHORT_LINK_HOSTS` configuration) refuse because those redirects replace tags; third-party links are not categorically blocked.

Media support:

- `--image-url` or `--video-url`: the Meta CLI transport downloads the media and lets the CLI upload/create. Video upload may succeed before a later creative failure; that whole operation remains uncertain.
- `--image-hash`: an already-uploaded image for direct Graph. This does not upload a file.
- `--asset-feed-spec '<JSON object>'`: pre-existing media references/URLs and destination links, supported by both transports. Raw actions also accept `degreesOfFreedomSpec` and default to enhancements off.
- Standard direct-Graph video URL creation is explicitly unsupported. Use the CLI transport or an appropriate feed containing existing references.

A provider throttle establishes a durable 45-minute local account cooldown, including when the same operation's mutation remains uncertain. Other sources/workspaces in this daemon on that account share the hold. Failed audit diagnostics preserve the hold if the dedicated cooldown write fails. It is local state, not a substitute for a cloud-wide request budget. Writes are never automatically retried.

Daemon HTTP/MCP errors retain bounded, sanitized `metaWrite` phase/outcome/provider metadata and `metaMessage`. The CLI retains these fields on errors. No provider credentials enter identity evidence, cooldown rows or error envelopes.

The next desktop bundle must include the new engine migration and daemon/CLI bytes. Cloud isolated-server execution skips the local evidence/cooldown tables and continues to use its host's identity, budget and authority checks.
