import type { SubagentAggregate, SubagentNode, SubagentProgress } from "../types.js";

const ROOT_KEY = "__root__";
const SPARK_RAMP = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export function buildSubagentTree(items: readonly SubagentProgress[]): SubagentNode[] {
  if (!items.length) {
    return [];
  }

  const byParent = new Map<string, SubagentProgress[]>();
  const known = new Set(items.map((item) => item.id));

  for (const item of items) {
    const parentKey = item.parentId && known.has(item.parentId) ? item.parentId : ROOT_KEY;
    const bucket = byParent.get(parentKey) ?? [];
    bucket.push(item);
    byParent.set(parentKey, bucket);
  }

  for (const bucket of byParent.values()) {
    bucket.sort((a, b) => a.depth - b.depth || a.index - b.index);
  }

  const build = (item: SubagentProgress): SubagentNode => {
    const children = (byParent.get(item.id) ?? []).map(build);
    return { aggregate: aggregateSubagent(item, children), children, item };
  };

  return (byParent.get(ROOT_KEY) ?? []).map(build);
}

export function aggregateSubagent(
  item: SubagentProgress,
  children: readonly SubagentNode[]
): SubagentAggregate {
  let totalTools = item.toolCount ?? 0;
  let totalDuration = item.durationSeconds ?? 0;
  let descendantCount = 0;
  let activeCount = isRunningSubagent(item) ? 1 : 0;
  let maxDepthFromHere = 0;
  let inputTokens = item.inputTokens ?? 0;
  let outputTokens = item.outputTokens ?? 0;
  let costUsd = item.costUsd ?? 0;
  let filesTouched = (item.filesRead?.length ?? 0) + (item.filesWritten?.length ?? 0);

  for (const child of children) {
    totalTools += child.aggregate.totalTools;
    totalDuration += child.aggregate.totalDuration;
    descendantCount += child.aggregate.descendantCount + 1;
    activeCount += child.aggregate.activeCount;
    maxDepthFromHere = Math.max(maxDepthFromHere, child.aggregate.maxDepthFromHere + 1);
    inputTokens += child.aggregate.inputTokens;
    outputTokens += child.aggregate.outputTokens;
    costUsd += child.aggregate.costUsd;
    filesTouched += child.aggregate.filesTouched;
  }

  return {
    activeCount,
    costUsd,
    descendantCount,
    filesTouched,
    hotness: totalDuration > 0 ? totalTools / totalDuration : 0,
    inputTokens,
    maxDepthFromHere,
    outputTokens,
    totalDuration,
    totalTools
  };
}

export function treeTotals(tree: readonly SubagentNode[]): SubagentAggregate {
  let totalTools = 0;
  let totalDuration = 0;
  let descendantCount = 0;
  let activeCount = 0;
  let maxDepthFromHere = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let filesTouched = 0;

  for (const node of tree) {
    totalTools += node.aggregate.totalTools;
    totalDuration += node.aggregate.totalDuration;
    descendantCount += node.aggregate.descendantCount + 1;
    activeCount += node.aggregate.activeCount;
    maxDepthFromHere = Math.max(maxDepthFromHere, node.aggregate.maxDepthFromHere + 1);
    inputTokens += node.aggregate.inputTokens;
    outputTokens += node.aggregate.outputTokens;
    costUsd += node.aggregate.costUsd;
    filesTouched += node.aggregate.filesTouched;
  }

  return {
    activeCount,
    costUsd,
    descendantCount,
    filesTouched,
    hotness: totalDuration > 0 ? totalTools / totalDuration : 0,
    inputTokens,
    maxDepthFromHere,
    outputTokens,
    totalDuration,
    totalTools
  };
}

export function widthByDepth(tree: readonly SubagentNode[]): number[] {
  const widths: number[] = [];

  const walk = (nodes: readonly SubagentNode[], depth: number) => {
    for (const node of nodes) {
      widths[depth] = (widths[depth] ?? 0) + 1;
      walk(node.children, depth + 1);
    }
  };

  walk(tree, 0);
  return widths;
}

export function subagentSparkline(values: readonly number[]): string {
  if (!values.length) {
    return "";
  }

  const max = Math.max(...values);
  if (max <= 0) {
    return " ".repeat(values.length);
  }

  return values
    .map((value) => {
      if (value <= 0) {
        return " ";
      }
      const index = Math.min(SPARK_RAMP.length - 1, Math.max(0, Math.ceil((value / max) * (SPARK_RAMP.length - 1))));
      return SPARK_RAMP[index];
    })
    .join("");
}

export function formatSubagentSummary(totals: SubagentAggregate): string {
  const pieces = [`d${Math.max(0, totals.maxDepthFromHere)}`];
  pieces.push(`${totals.descendantCount} agent${totals.descendantCount === 1 ? "" : "s"}`);

  if (totals.totalTools > 0) {
    pieces.push(`${totals.totalTools} tool${totals.totalTools === 1 ? "" : "s"}`);
  }
  if (totals.totalDuration > 0) {
    pieces.push(formatDuration(totals.totalDuration));
  }

  const tokens = totals.inputTokens + totals.outputTokens;
  if (tokens > 0) {
    pieces.push(`${formatTokens(tokens)} tok`);
  }
  if (totals.costUsd > 0) {
    pieces.push(formatCost(totals.costUsd));
  }
  if (totals.activeCount > 0) {
    pieces.push(`active ${totals.activeCount}`);
  }

  return pieces.join(" · ");
}

export function isRunningSubagent(item: Pick<SubagentProgress, "status">): boolean {
  return item.status === "running" || item.status === "queued";
}

function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) {
    return "";
  }
  if (usd < 0.01) {
    return "<$0.01";
  }
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(1)}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.max(0, Math.round(seconds))}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds - minutes * 60);
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value < 1000) {
    return String(Math.round(value));
  }
  if (value < 10_000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return `${Math.round(value / 1000)}k`;
}
