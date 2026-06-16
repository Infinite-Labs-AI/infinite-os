import { randomUUID } from "node:crypto";
import type { ChatActionCall } from "./index.js";

export type CuratedMemoryScope =
  | "workspace_preference"
  | "metric_preference"
  | "report_preference"
  | "operator_correction"
  | "source_naming";

export interface CuratedMemoryCandidate {
  scope: CuratedMemoryScope | string;
  fact: string;
}

export interface CuratedMemoryFact extends CuratedMemoryCandidate {
  id?: string;
}

export interface MemoryReviewInput {
  workspaceId: string;
  actorId: string;
  sessionId: string;
  userMessage: string;
  assistantMessage: string;
  actionCalls: ChatActionCall[];
}

export interface MemoryReviewDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface InfiniteOsMemoryManager {
  loadPromptContext?(input: { workspaceId: string; actorId: string; sessionId: string }): Promise<CuratedMemoryFact[]>;
  rememberFacts?(input: {
    workspaceId: string;
    actorId: string;
    sessionId: string;
    facts: CuratedMemoryCandidate[];
  }): Promise<void>;
  reviewTurn(input: MemoryReviewInput): Promise<void>;
}

export interface CreateCuratedMemoryManagerOptions {
  db: MemoryReviewDb;
  reviewer: (input: MemoryReviewInput) => Promise<CuratedMemoryCandidate[]> | CuratedMemoryCandidate[];
}

export interface MemoryReviewModelClient {
  complete(request: {
    systemPrompt: string;
    userMessage: string;
    tools: [];
    toolResults: [];
  }): Promise<{ message?: string }>;
}

const ALLOWED_SCOPES = new Set<CuratedMemoryScope>([
  "workspace_preference",
  "metric_preference",
  "report_preference",
  "operator_correction",
  "source_naming"
]);

const FORBIDDEN_FACT_PATTERNS = [
  /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|credential)\b/i,
  /\braw[_ -]?payload\b/i,
  /\btemporary task\b/i,
  /\btask progress\b/i
];

export function filterCuratedMemoryCandidates(
  candidates: CuratedMemoryCandidate[]
): CuratedMemoryCandidate[] {
  const seen = new Set<string>();
  const accepted: CuratedMemoryCandidate[] = [];
  for (const candidate of candidates) {
    const scope = candidate.scope;
    const fact = candidate.fact.trim();
    const key = `${scope}:${fact.toLowerCase()}`;
    if (!ALLOWED_SCOPES.has(scope as CuratedMemoryScope)) {
      continue;
    }
    if (!fact || fact.length > 1000 || FORBIDDEN_FACT_PATTERNS.some((pattern) => pattern.test(fact))) {
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    accepted.push({ scope, fact });
  }
  return accepted;
}

export function createCuratedMemoryManager(
  options: CreateCuratedMemoryManagerOptions
): InfiniteOsMemoryManager {
  return {
    async loadPromptContext(input) {
      const rows = await options.db.query<CuratedMemoryFact>(
        `
          select id, scope, fact
          from chat_memory_facts
          where workspace_id = $1
            and blocked_reason is null
            and (expires_at is null or expires_at > now())
          order by updated_at desc
          limit 20
        `,
        [input.workspaceId]
      );
      const accepted: CuratedMemoryFact[] = [];
      for (const row of rows) {
        const [fact] = filterCuratedMemoryCandidates([{ scope: row.scope, fact: row.fact }]);
        if (fact) {
          accepted.push({ ...fact, id: row.id });
        }
      }
      return accepted;
    },
    async rememberFacts(input) {
      const facts = filterCuratedMemoryCandidates(input.facts);
      for (const fact of facts) {
        await insertCuratedMemoryFact(options.db, {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          sessionId: input.sessionId,
          fact
        });
      }
    },
    async reviewTurn(input) {
      const facts = filterCuratedMemoryCandidates(await options.reviewer(input));
      for (const fact of facts) {
        await insertCuratedMemoryFact(options.db, {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          sessionId: input.sessionId,
          fact
        });
      }
    }
  };
}

async function insertCuratedMemoryFact(
  db: MemoryReviewDb,
  input: {
    workspaceId: string;
    actorId: string;
    sessionId: string;
    fact: CuratedMemoryCandidate;
  }
): Promise<void> {
  await db.query(
    `
      insert into chat_memory_facts (
        id, workspace_id, actor_id, scope, fact, source_session_id
      )
      select $1, $2, $3, $4, $5, $6
      where not exists (
        select 1
        from chat_memory_facts
        where workspace_id = $2
          and scope = $4
          and lower(fact) = lower($5)
          and blocked_reason is null
      )
    `,
    [
      `mem_${randomUUID()}`,
      input.workspaceId,
      input.actorId,
      input.fact.scope,
      input.fact.fact,
      input.sessionId
    ]
  );
}

export function createModelBackedMemoryReviewer(
  modelClient: MemoryReviewModelClient
): (input: MemoryReviewInput) => Promise<CuratedMemoryCandidate[]> {
  return async (input) => {
    const response = await modelClient.complete({
      systemPrompt: memoryReviewPrompt(),
      userMessage: JSON.stringify({
        userMessage: input.userMessage,
        assistantMessage: input.assistantMessage,
        actionCalls: input.actionCalls.map((call) => ({
          actionId: call.actionId,
          status: call.status,
          provenance: call.envelope?.provenance ?? [],
          caveats: call.envelope?.caveats ?? []
        }))
      }),
      tools: [],
      toolResults: []
    });
    return filterCuratedMemoryCandidates(parseMemoryCandidates(response.message ?? ""));
  };
}

function memoryReviewPrompt(): string {
  return [
    "Review this Infinite OS chat turn after the user-facing answer has completed.",
    "Return JSON only: {\"memories\":[{\"scope\":\"workspace_preference|metric_preference|report_preference|operator_correction|source_naming\",\"fact\":\"...\"}]}",
    "Allowed durable memory: workspace conventions, operator preferences, recurring report preferences, metric interpretation corrections, stable source naming conventions, remembered analytical decisions.",
    "Forbidden durable memory: credentials, tokens, secrets, raw provider payloads, row dumps, unverified metric values as evergreen facts, temporary task progress, arbitrary personal profiling."
  ].join("\n");
}

function parseMemoryCandidates(message: string): CuratedMemoryCandidate[] {
  const parsed = parseJsonObject(message);
  const candidates = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.memories)
      ? parsed.memories
      : [];
  return candidates.flatMap((candidate): CuratedMemoryCandidate[] => {
    if (!isRecord(candidate) || typeof candidate.scope !== "string" || typeof candidate.fact !== "string") {
      return [];
    }
    return [{ scope: candidate.scope, fact: candidate.fact }];
  });
}

function parseJsonObject(message: string): unknown {
  try {
    return JSON.parse(message);
  } catch {
    const start = message.indexOf("{");
    const end = message.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return undefined;
    }
    try {
      return JSON.parse(message.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
