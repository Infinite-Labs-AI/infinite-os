export type {
  ApplyMode,
  ApplyResult,
  FrameworkAdapter,
  FrameworkApplyContext,
  FrameworkApplyResult,
  FrameworkUninstallContext,
  FrameworkUninstallResult,
  Ga4PublicArtifact,
  InfiniteBrowserConfig,
  InfiniteConsentMode,
  InfinitePublicArtifact,
  InfiniteProxySpec,
  InspectResult,
  InstallInstruction,
  InstallManifest,
  InstallPlan,
  ManagedTextEdit,
  MetaPublicArtifact,
  PackageManager,
  PackageManagerCommands,
  PackageManagerDetection,
  PosthogPublicArtifact,
  ProviderAdapter,
  ProviderId,
  ProviderPlanDraft,
  RepoStatus,
  ServerLaneManifest,
  ServerLaneMiddlewareAction,
  ServerLaneMode,
  ServerLanePlan,
  SupportedFramework,
  UninstallResult,
  VerifyResult,
  WorkspaceInstallArtifacts,
  XPublicArtifact
} from "./types.js"

export { applyInstallation } from "./apply.js"
export { frameworkAdapters, getFrameworkAdapter, isSupportedFramework } from "./frameworks/index.js"
export { detectRepoStatus, inspectWorkspace } from "./inspect.js"
export {
  computeContentHashes,
  installManifestPath,
  installManifestRelativePath,
  readInstallManifest,
  writeInstallManifest,
  writeInstallManifestIfChanged
} from "./manifest.js"
export { buildPackageManagerCommands, detectPackageManager } from "./package-manager.js"
export { planInstallation } from "./plan.js"
export { getProviderAdapter, providerAdapters } from "./providers/index.js"
// Public bootstrap-snippet builders + the <script> framing, reused by the CLI's
// per-provider manual-install fallback printers so the manual copy never drifts
// from the tested snippets the installer writes.
export { buildPostHogBootstrapSnippet, wrapHtmlSnippet } from "./providers/posthog.js"
export { buildXBootstrapSnippet } from "./providers/x.js"
export { renderInfiniteBrowserTag } from "./providers/infinite.js"
export { buildMetaPixelSnippet } from "./providers/meta.js"
export { runCli } from "./cli.js"
export { uninstallInstallation } from "./uninstall.js"
export {
  DEFAULT_INFINITE_COLLECT_PATH,
  INFINITE_API_ORIGIN,
  INFINITE_COLLECT_DESTINATION,
  INFINITE_SERVER_EVENTS_DESTINATION,
  INFINITE_SERVER_LANE_RECEIPT_URL,
  applyInfiniteApiOrigin,
  applyInfiniteAutocapture,
  infiniteCollectDestination,
  resolveInfiniteApiOrigin,
  resolveWorkspaceArtifacts
} from "./workspace-artifacts.js"
export { verifyInstallation } from "./verify.js"
// Server lane (lossless analytics): the recipe, the generated Next.js code, the brief, the verifier.
export {
  AUTOMATION_USER_AGENT_PATTERN,
  DOCUMENT_REQUEST_EVENT_NAME,
  SERVER_LANE_SECRET_ENV,
  SERVER_LANE_SIGNATURE_HEADER,
  SERVER_LANE_SOURCE_KEY_ENV,
  SERVER_LANE_SOURCE_KEY_HEADER,
  VISIT_BUCKET_SECONDS,
  buildDocumentRequestEvent,
  buildSignedServerEventRequest,
  classifyUserAgent,
  computeDocumentEventId,
  computeVisitKey,
  hmacHex,
  isDocumentPath,
  shouldRecordDocumentRequest,
  signServerEventBody
} from "./server-lane/helpers.js"
export {
  NEXT_DOCUMENT_MATCHER,
  SERVER_LANE_FENCE_END,
  SERVER_LANE_FENCE_START,
  buildCreatedMiddlewareSource,
  buildServerLaneModuleSource
} from "./server-lane/runtime-source.js"
export { patchExistingMiddleware } from "./server-lane/middleware-patch.js"
export {
  SERVER_LANE_BRIEF_FILE,
  SERVER_LANE_POSITIONING,
  renderServerLaneBrief,
  serverLaneCopy
} from "./server-lane/copy.js"
export {
  planServerLane,
  applyServerLane,
  reverseServerLane,
  selectServerLaneTarget,
  serverLaneTargetForMode
} from "./server-lane/install.js"
export { detectHosting, detectHostingWithEvidence, isCloudflarePagesProject } from "./server-lane/hosting.js"
export type { ServerLaneHosting } from "./server-lane/hosting.js"
export {
  parseReceipt,
  receiptRequestSignature,
  renderServerLaneVerify,
  verifyServerLane
} from "./server-lane/verify.js"
