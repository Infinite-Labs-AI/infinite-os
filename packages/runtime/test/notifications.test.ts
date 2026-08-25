import { describe, expect, it } from "vitest";

import {
  createLogNotificationSink,
  createNotificationSinkFromEnv,
  createNotificationEvent,
  createWebhookNotificationSink,
  renderProgressBar
} from "../src/index.js";

describe("typed notifications", () => {
  it("creates structured product-owned notification events", () => {
    const event = createNotificationEvent({
      type: "sync_failed",
      workspaceId: "workspace",
      sourceId: "src_1",
      jobId: "job_1",
      error: "rate_limited"
    });

    expect(event).toMatchObject({
      type: "sync_failed",
      workspaceId: "workspace",
      sourceId: "src_1",
      jobId: "job_1",
      status: "error",
      summary: "Sync failed for src_1",
      details: { error: "rate_limited" }
    });
    expect(Date.parse(event.occurredAt)).not.toBeNaN();
  });

  it("creates 0 to 100 progress notifications with a rendered bar", () => {
    const event = createNotificationEvent({
      type: "sync_progress",
      workspaceId: "workspace",
      sourceId: "src_meta_ads",
      jobId: "job_1",
      progressPercent: 100,
      details: { provider: "meta_ads", jobType: "source_backfill" }
    });

    expect(renderProgressBar(0)).toBe("[--------------------] 0%");
    expect(renderProgressBar(100)).toBe("[####################] 100%");
    expect(event).toMatchObject({
      type: "sync_progress",
      workspaceId: "workspace",
      sourceId: "src_meta_ads",
      jobId: "job_1",
      status: "info",
      summary: "Meta Ads backfill progress for src_meta_ads [####################] 100%",
      details: {
        provider: "meta_ads",
        jobType: "source_backfill",
        progressPercent: 100,
        progressBar: "[####################] 100%"
      }
    });
  });

  it("supports local log and webhook sinks without messaging platform surfaces", async () => {
    const logged: string[] = [];
    const logSink = createLogNotificationSink((line) => logged.push(line));
    const event = createNotificationEvent({
      type: "export_ready",
      workspaceId: "workspace",
      reportId: "report_1",
      artifactPath: "/tmp/report.json"
    });

    await logSink.emit(event);
    expect(JSON.parse(logged[0] ?? "{}")).toMatchObject({
      notification: {
        type: "export_ready",
        workspaceId: "workspace",
        reportId: "report_1",
        artifactPath: "/tmp/report.json",
        status: "info"
      }
    });

    const webhookCalls: Array<{ url: string; body: unknown }> = [];
    const webhookSink = createWebhookNotificationSink("https://hooks.example/growth-os", (async (
      url: RequestInfo | URL,
      init?: RequestInit
    ) => {
      webhookCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response("ok");
    }) as typeof fetch);

    await webhookSink.emit(event);
    expect(webhookCalls).toEqual([
      { url: "https://hooks.example/growth-os", body: event }
    ]);
  });

  it("selects webhook notifications from explicit Infinite OS environment", async () => {
    const webhookCalls: Array<{ url: string; body: unknown }> = [];
    const sink = createNotificationSinkFromEnv(
      { GROWTH_OS_NOTIFICATION_WEBHOOK_URL: "https://hooks.example/growth-os" },
      {
        fetcher: (async (url: RequestInfo | URL, init?: RequestInit) => {
          webhookCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return new Response("ok");
        }) as typeof fetch
      }
    );
    const event = createNotificationEvent({
      type: "sync_completed",
      workspaceId: "workspace",
      sourceId: "src_1"
    });

    await sink.emit(event);

    expect(webhookCalls).toEqual([{ url: "https://hooks.example/growth-os", body: event }]);
  });
});
