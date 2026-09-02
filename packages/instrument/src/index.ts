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
// The analytics harness: one runbook (adopt → install → mark → verify → report) shared by
// `infinite-tag harness` and the desktop CLI's `infinite analytics`.
export { parseHarnessArgs, hasExplicitArtifacts, HARNESS_HELP_LINES } from "./harness/args.js"
export type { HarnessArgs } from "./harness/args.js"
export {
  CONVERSIONS_REQUIRED_MESSAGE,
  EXIT_ARGS,
  EXIT_FAILED,
  EXIT_OK,
  conversionsArgumentError,
  infErrorLine,
  isInteractiveTerminal,
  runHarnessCommand,
  terminalIo
} from "./harness/command.js"
export { HARNESS_BRIEF_RELATIVE_PATH, runHarness } from "./harness/run.js"
export type { HarnessDeps, HarnessIo, HarnessRunResult } from "./harness/run.js"
export {
  HARNESS_HANDOFF_LINE,
  HARNESS_PROVIDER_ORDER,
  HARNESS_REPORT_RELATIVE_PATH,
  renderReportMarkdown,
  renderReportTable
} from "./harness/state.js"
export type {
  HarnessFailure,
  HarnessFailureCode,
  HarnessMode,
  HarnessProviderId,
  HarnessReport,
  ProviderState,
  ProviderStateKind,
  VerificationOutcome
} from "./harness/types.js"
export { HARNESS_FAILURE_CODES } from "./harness/types.js"
export {
  CONVERSIONS_MANIFEST_RELATIVE_PATH,
  PROPOSED_CONVERSIONS_RELATIVE_PATH,
  applyConversions,
  proposeConversions,
  readApprovedConversions,
  unmarkConversions
} from "./harness/marking.js"
export {
  HARNESS_OUTPUTS_RELATIVE_PATH,
  readHarnessOutputs,
  removeHarnessOutputs
} from "./harness/outputs.js"
export {
  CloudReportSink,
  DesktopBridgeReportSink,
  NO_DESKTOP_REPORT_REASON,
  NoneReportSink,
  REPORT_SENT_LINE,
  buildHarnessReportPayload,
  redactProviderIds,
  reportNotSentLine
} from "./harness/report-sink.js"
export type {
  CloudReportSinkOptions,
  DesktopBridgeReportSinkOptions,
  HarnessReportPayload,
  HarnessReportProviderPayload,
  ReportSendResult,
  ReportSink
} from "./harness/report-sink.js"
export {
  DESKTOP_UPDATE_REQUIRED_REASON,
  DesktopBridgeBackend,
  InfiniteCloudBackend,
  NoneBackend,
  PosthogQueryBackend,
  VERIFY_BUDGET_MS,
  VERIFY_POLL_INTERVAL_MS,
  desktopNotReadyReason,
  verifyLanes
} from "./harness/verify.js"
export type { LaneVerification, VerificationBackend, VerifyLane } from "./harness/verify.js"
