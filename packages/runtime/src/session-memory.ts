import type { ActionEnvelope } from "./index.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface SessionMemoryState {
  workspaceId: string;
  workspaceRoot?: string;
  activeSourceIds: string[];
  lastQuestion?: string;
  lastAnswerId?: string;
  lastAnswerSummary?: string;
  preferredTimezone?: string;
  defaultPopularityMetric?: string;
  lastReportId?: string;
  lastExportTarget?: string;
}

export interface PersistedSessionMemoryState {
  workspaceId: string;
  workspaceRoot?: string;
  preferredSourceIds: string[];
  preferredTimezone?: string;
  defaultPopularityMetric?: string;
  lastReportId?: string;
  lastExportTarget?: string;
  updatedAt: string;
}

export interface SessionMemoryStore {
  load(): PersistedSessionMemoryState | null;
  save(state: PersistedSessionMemoryState): void;
}

const MAX_ACTIVE_SOURCES = 12;
const MAX_TEXT = 500;

export class OperatorSessionMemory {
  private state: SessionMemoryState;

  constructor(initial: Partial<SessionMemoryState> = {}) {
    this.state = {
      workspaceId: initial.workspaceId ?? "default",
      workspaceRoot: boundedText(initial.workspaceRoot),
      activeSourceIds: boundedSources(initial.activeSourceIds ?? []),
      lastQuestion: boundedText(initial.lastQuestion),
      lastAnswerId: boundedText(initial.lastAnswerId),
      lastAnswerSummary: boundedText(initial.lastAnswerSummary),
      preferredTimezone: boundedText(initial.preferredTimezone ?? "UTC"),
      defaultPopularityMetric: boundedText(initial.defaultPopularityMetric),
      lastReportId: boundedText(initial.lastReportId),
      lastExportTarget: boundedText(initial.lastExportTarget)
    };
  }

  snapshot(): SessionMemoryState {
    return {
      ...this.state,
      activeSourceIds: [...this.state.activeSourceIds]
    };
  }

  update(patch: Partial<SessionMemoryState>): SessionMemoryState {
    this.state = {
      ...this.state,
      ...patch,
      workspaceId: boundedText(patch.workspaceId) ?? this.state.workspaceId,
      workspaceRoot: boundedText(patch.workspaceRoot) ?? this.state.workspaceRoot,
      activeSourceIds: patch.activeSourceIds
        ? boundedSources(patch.activeSourceIds)
        : this.state.activeSourceIds,
      lastQuestion: boundedText(patch.lastQuestion) ?? this.state.lastQuestion,
      lastAnswerId: boundedText(patch.lastAnswerId) ?? this.state.lastAnswerId,
      lastAnswerSummary: boundedText(patch.lastAnswerSummary) ?? this.state.lastAnswerSummary,
      preferredTimezone: boundedText(patch.preferredTimezone) ?? this.state.preferredTimezone,
      defaultPopularityMetric: boundedText(patch.defaultPopularityMetric) ?? this.state.defaultPopularityMetric,
      lastReportId: boundedText(patch.lastReportId) ?? this.state.lastReportId,
      lastExportTarget: boundedText(patch.lastExportTarget) ?? this.state.lastExportTarget
    };
    return this.snapshot();
  }

  updatePreferences(
    patch: Pick<
      Partial<SessionMemoryState>,
      | "activeSourceIds"
      | "preferredTimezone"
      | "defaultPopularityMetric"
      | "lastReportId"
      | "lastExportTarget"
    >
  ): SessionMemoryState {
    return this.update(patch);
  }

  rememberQuestion(question: string): SessionMemoryState {
    return this.update({ lastQuestion: question });
  }

  rememberEnvelope(envelope: ActionEnvelope): SessionMemoryState {
    const data = isRecord(envelope.data) ? envelope.data : {};
    const sourceIds = sourceIdsFromData(data);
    const reportId = reportIdFromData(data);
    const exportTarget = exportTargetFromData(data);

    return this.update({
      ...(sourceIds.length ? { activeSourceIds: sourceIds } : {}),
      ...(reportId ? { lastReportId: reportId } : {}),
      ...(exportTarget ? { lastExportTarget: exportTarget } : {}),
      lastAnswerId: envelope.actionId,
      lastAnswerSummary: summarizeEnvelope(envelope)
    });
  }

  persistedState(): PersistedSessionMemoryState {
    return {
      workspaceId: this.state.workspaceId,
      workspaceRoot: this.state.workspaceRoot,
      preferredSourceIds: [...this.state.activeSourceIds],
      preferredTimezone: this.state.preferredTimezone,
      defaultPopularityMetric: this.state.defaultPopularityMetric,
      lastReportId: this.state.lastReportId,
      lastExportTarget: this.state.lastExportTarget,
      updatedAt: new Date().toISOString()
    };
  }

  reset(): SessionMemoryState {
    this.state = {
      workspaceId: this.state.workspaceId,
      workspaceRoot: this.state.workspaceRoot,
      activeSourceIds: [],
      preferredTimezone: this.state.preferredTimezone,
      defaultPopularityMetric: this.state.defaultPopularityMetric,
      lastReportId: this.state.lastReportId,
      lastExportTarget: this.state.lastExportTarget
    };
    return this.snapshot();
  }
}

export function createOperatorSessionMemory(
  initial: Partial<SessionMemoryState> = {},
  store?: SessionMemoryStore
): OperatorSessionMemory {
  const persisted = store?.load();
  return new OperatorSessionMemory({
    ...persistedToSessionState(persisted),
    ...initial
  });
}

export class FileSessionMemoryStore implements SessionMemoryStore {
  constructor(private readonly filePath: string) {}

  load(): PersistedSessionMemoryState | null {
    if (!existsSync(this.filePath)) return null;
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    return sanitizePersistedState(parsed);
  }

  save(state: PersistedSessionMemoryState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(sanitizePersistedState(state), null, 2));
  }
}

export function createFileSessionMemoryStore(workspaceRoot: string): FileSessionMemoryStore {
  return new FileSessionMemoryStore(sessionMemoryPathForRoot(workspaceRoot));
}

export function sessionMemoryPathForRoot(workspaceRoot: string): string {
  return join(resolve(workspaceRoot), ".growth-os", "session-memory.json");
}

export function summarizeEnvelope(envelope: ActionEnvelope): string {
  const data = isRecord(envelope.data) ? envelope.data : {};
  if ("rows" in data && Array.isArray(data.rows)) {
    return `${envelope.actionId}: ${data.rows.length} rows`;
  }
  if ("job" in data) {
    return `${envelope.actionId}: job queued`;
  }
  if ("artifact" in data) {
    return `${envelope.actionId}: artifact queued`;
  }
  return `${envelope.actionId}: ${envelope.status}`;
}

function boundedSources(sourceIds: string[]): string[] {
  return [
    ...new Set(
      sourceIds
        .filter((sourceId) => typeof sourceId === "string" && sourceId.trim() !== "")
        .map((sourceId) => sourceId.trim())
    )
  ].slice(0, MAX_ACTIVE_SOURCES);
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_TEXT);
}

function sourceIdsFromData(data: Record<string, unknown>): string[] {
  if (Array.isArray(data.sources)) {
    return data.sources
      .map((source) => (isRecord(source) && typeof source.id === "string" ? source.id : undefined))
      .filter((sourceId): sourceId is string => Boolean(sourceId));
  }
  if (isRecord(data.source) && typeof data.source.id === "string") {
    return [data.source.id];
  }
  if (typeof data.sourceId === "string") {
    return [data.sourceId];
  }
  return [];
}

function reportIdFromData(data: Record<string, unknown>): string | undefined {
  if (isRecord(data.report) && typeof data.report.id === "string") {
    return data.report.id;
  }
  if (typeof data.reportId === "string") {
    return data.reportId;
  }
  return undefined;
}

function exportTargetFromData(data: Record<string, unknown>): string | undefined {
  if (isRecord(data.artifact) && typeof data.artifact.artifactPath === "string") {
    return data.artifact.artifactPath;
  }
  if (typeof data.artifactPath === "string") {
    return data.artifactPath;
  }
  return undefined;
}

function persistedToSessionState(
  persisted: PersistedSessionMemoryState | null | undefined
): Partial<SessionMemoryState> {
  if (!persisted) return {};
  return {
    workspaceId: persisted.workspaceId,
    workspaceRoot: persisted.workspaceRoot,
    activeSourceIds: persisted.preferredSourceIds,
    preferredTimezone: persisted.preferredTimezone,
    defaultPopularityMetric: persisted.defaultPopularityMetric,
    lastReportId: persisted.lastReportId,
    lastExportTarget: persisted.lastExportTarget
  };
}

function sanitizePersistedState(value: unknown): PersistedSessionMemoryState {
  if (!isRecord(value)) {
    throw new Error("invalid_session_memory_state");
  }
  return {
    workspaceId: boundedText(value.workspaceId) ?? "default",
    workspaceRoot: boundedText(value.workspaceRoot),
    preferredSourceIds: boundedSources(
      Array.isArray(value.preferredSourceIds) ? value.preferredSourceIds : []
    ),
    preferredTimezone: boundedText(value.preferredTimezone ?? "UTC"),
    defaultPopularityMetric: boundedText(value.defaultPopularityMetric),
    lastReportId: boundedText(value.lastReportId),
    lastExportTarget: boundedText(value.lastExportTarget),
    updatedAt: boundedText(value.updatedAt) ?? new Date().toISOString()
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
