import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEnvelope,
  createFileSessionMemoryStore,
  createOperatorSessionMemory,
  sessionMemoryPathForRoot
} from "../src/index.js";

describe("operator session memory", () => {
  it("keeps only bounded shell state", () => {
    const memory = createOperatorSessionMemory({
      workspaceId: "workspace",
      workspaceRoot: "/workspace",
      activeSourceIds: Array.from({ length: 20 }, (_, index) => `src_${index}`),
      preferredTimezone: "Europe/London",
      lastQuestion: "x".repeat(800)
    });

    const snapshot = memory.snapshot();
    expect(snapshot.workspaceId).toBe("workspace");
    expect(snapshot.workspaceRoot).toBe("/workspace");
    expect(snapshot.activeSourceIds).toHaveLength(12);
    expect(snapshot.preferredTimezone).toBe("Europe/London");
    expect(snapshot.lastQuestion).toHaveLength(500);
  });

  it("remembers answer summaries from action envelopes without deterministic plans", () => {
    const memory = createOperatorSessionMemory();
    memory.rememberEnvelope(
      createEnvelope({
        actionId: "run_metric_query",
        authority: "tool_agent",
        status: "ok",
        data: {
          metric: "recognized_revenue",
          view: "queryable.vw_revenue_by_source",
          rows: [{ month: "2026-06", value: 123 }]
        },
        provenance: ["queryable.vw_revenue_by_source"],
        caveats: ["content_linkage_not_implemented"],
        nextActions: ["run_metric_query", "explain_answer"]
      })
    );

    const snapshot = memory.snapshot();
    expect(snapshot.lastQuestion).toBeUndefined();
    expect(snapshot.lastAnswerSummary).toBe("run_metric_query: 1 rows");
  });

  it("persists only explicit workspace preferences and report/export pointers", () => {
    const root = mkdtempSync(join(tmpdir(), "growth-os-memory-"));
    try {
      const store = createFileSessionMemoryStore(root);
      const memory = createOperatorSessionMemory({
        workspaceId: "workspace",
        workspaceRoot: root,
        preferredTimezone: "Europe/London",
        defaultPopularityMetric: "impression_count",
        activeSourceIds: ["src_1", "src_2"],
        lastQuestion: "Do not persist this question"
      });

      memory.rememberEnvelope(
        createEnvelope({
          actionId: "export_saved_report",
          authority: "operator",
          status: "queued",
          data: {
            reportId: "report_1",
            artifact: { artifactPath: "/workspace/.growth-os/exports/report.json" }
          }
        })
      );
      store.save(memory.persistedState());

      const persisted = JSON.parse(readFileSync(sessionMemoryPathForRoot(root), "utf8"));
      expect(persisted).toMatchObject({
        workspaceId: "workspace",
        workspaceRoot: root,
        preferredSourceIds: ["src_1", "src_2"],
        preferredTimezone: "Europe/London",
        defaultPopularityMetric: "impression_count",
        lastReportId: "report_1",
        lastExportTarget: "/workspace/.growth-os/exports/report.json"
      });
      expect(persisted).not.toHaveProperty("lastQuestion");

      const loaded = createOperatorSessionMemory({}, store).snapshot();
      expect(loaded).toMatchObject({
        workspaceId: "workspace",
        activeSourceIds: ["src_1", "src_2"],
        preferredTimezone: "Europe/London",
        defaultPopularityMetric: "impression_count",
        lastReportId: "report_1"
      });
      expect(loaded.lastQuestion).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
