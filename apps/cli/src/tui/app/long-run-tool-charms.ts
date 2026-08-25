import { LONG_RUN_CHARMS } from "../content/charms.js";
import { pick, toolTrailLabel } from "../lib/text.js";
import type { ActiveTool, ActivityItem } from "../types.js";

const DELAY_MS = 8_000;
const INTERVAL_MS = 10_000;
const MAX_CHARMS_PER_TOOL = 2;

interface Slot {
  count: number;
  lastAt: number;
}

export interface LongRunCharmSink {
  pushActivity(text: string, tone?: ActivityItem["tone"], replaceLabel?: string): void;
}

export class LongRunToolCharmTicker {
  private readonly slots = new Map<string, Slot>();

  reset() {
    this.slots.clear();
  }

  tick(tools: readonly ActiveTool[], now: number, sink: LongRunCharmSink) {
    if (!tools.length) {
      this.reset();
      return;
    }

    const liveIds = new Set(tools.map((tool) => tool.id));

    for (const key of Array.from(this.slots.keys())) {
      if (!liveIds.has(key)) {
        this.slots.delete(key);
      }
    }

    for (const tool of tools) {
      if (!tool.startedAt || now - tool.startedAt < DELAY_MS) {
        continue;
      }

      const slot = this.slots.get(tool.id) ?? { count: 0, lastAt: 0 };

      if (slot.count >= MAX_CHARMS_PER_TOOL || now - slot.lastAt < INTERVAL_MS) {
        continue;
      }

      this.slots.set(tool.id, { count: slot.count + 1, lastAt: now });
      sink.pushActivity(
        `${pick(LONG_RUN_CHARMS)} (${toolTrailLabel(tool.name)} · ${Math.round((now - tool.startedAt) / 1000)}s)`
      );
    }
  }
}
