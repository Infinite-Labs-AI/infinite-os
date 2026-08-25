import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EMBEDDED_ONLY_READ_ACTIONS,
  LOCAL_STORE_READ_ACTIONS,
  READ_ACTIONS
} from "@infinite-os/types";

// ---------------------------------------------------------------------------
// LOCAL-STORE PIN TEST (Phase-2 native removal).
//
// Invariant: every action handler that reads the engine's synced data store —
// a `from queryable.<view>` / `from ${view}`-style aggregate / `*_truth`
// table read — is listed in LOCAL_STORE_READ_ACTIONS (and therefore in
// EMBEDDED_ONLY_READ_ACTIONS, which the daemon registry excludes). This is
// the tripwire that keeps a FUTURE engine action from shipping as a new
// daemon-advertised "local liar": adding a local-store read to a handler
// outside the pinned choke points fails this test and forces the author to
// classify the action.
//
// Mechanism: a source scan of this package's index.ts. Each match of a
// local-store FROM pattern is attributed to its nearest preceding TOP-LEVEL
// function declaration; that function must be a known choke point, and the
// hand-maintained choke-point → action map below must only name actions in
// LOCAL_STORE_READ_ACTIONS. The map is reviewed, not derived — if you change
// the call graph, update it deliberately.
// ---------------------------------------------------------------------------

const LOCAL_STORE_CHOKE_POINTS: Record<string, readonly string[]> = {
  // resolve_entity candidate lookups (Meta campaign/adset/ad + X content).
  resolveCampaignEntities: ["resolve_entity"],
  resolveAdsetEntities: ["resolve_entity"],
  resolveAdEntities: ["resolve_entity"],
  resolveXContentEntities: ["resolve_entity"],
  // Journey row producers behind rowsForCompiledJourney.
  metaCampaignJourneyRows: ["run_journey_query", "fetch_evidence", "verify_claims"],
  xContentJourneyRows: ["run_journey_query", "fetch_evidence", "verify_claims"],
  channelComparisonRows: ["run_journey_query", "fetch_evidence", "verify_claims"],
  // x_follower_count freshness backfill inside run_metric_query.
  backfillXFollowerSnapshotIfNeeded: ["run_metric_query"],
  // The shared aggregate executor (`from ${view}` over queryable.*).
  runAggregate: ["run_metric_query", "run_breakdown_query", "run_funnel_query"],
  // The no-data honesty classifier probes the fact tables directly.
  classifyNoData: ["run_metric_query", "run_breakdown_query"],
  // drilldown_result provider-truth rows (queryable value join + *_truth).
  providerTruthRows: ["drilldown_result"]
};

// Case-insensitive: SQL FROM may be upper- or lowercase. The declaration
// pattern also matches top-level `const name = (async) (…) =>` arrow
// functions, so a choke-point refactor from `function` to an arrow const
// cannot silently detach its reads from attribution.
const FROM_LOCAL_STORE = /\bfrom\s+(queryable\.|\$\{|[a-z_]*_truth\b)/i;
const TOP_LEVEL_FUNCTION =
  /^(?:export\s+)?(?:(?:async\s+)?function\s+([A-Za-z0-9_]+)|const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?(?:\(|[A-Za-z0-9_]+\s*=>))/;

function scanLocalStoreReads(): Array<{ line: number; fn: string | undefined }> {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "index.ts"), "utf8").split("\n");
  const matches: Array<{ line: number; fn: string | undefined }> = [];
  let currentFn: string | undefined;
  source.forEach((text, index) => {
    const fnMatch = TOP_LEVEL_FUNCTION.exec(text);
    if (fnMatch) {
      currentFn = fnMatch[1] ?? fnMatch[2];
    }
    if (FROM_LOCAL_STORE.test(text)) {
      matches.push({ line: index + 1, fn: currentFn });
    }
  });
  return matches;
}

describe("local-store read pin (Phase-2 native removal tripwire)", () => {
  it("attributes every local-store FROM site to a known choke point", () => {
    const matches = scanLocalStoreReads();
    // The scan must find the real read sites — an empty scan means the
    // patterns rotted, not that the store went unread.
    expect(matches.length).toBeGreaterThanOrEqual(10);
    for (const match of matches) {
      expect(
        match.fn && match.fn in LOCAL_STORE_CHOKE_POINTS,
        `index.ts:${match.line} reads the local store inside ${match.fn ?? "<module scope>"}, ` +
          "which is not a pinned choke point. If this is a new local-store read, add the " +
          "owning action to LOCAL_STORE_READ_ACTIONS in @infinite-os/types (it will then be " +
          "excluded from the daemon surface) and extend LOCAL_STORE_CHOKE_POINTS here."
      ).toBe(true);
    }
  });

  it("keeps every choke-point action inside LOCAL_STORE_READ_ACTIONS", () => {
    const pinned = new Set<string>(LOCAL_STORE_READ_ACTIONS);
    for (const [fn, actions] of Object.entries(LOCAL_STORE_CHOKE_POINTS)) {
      for (const action of actions) {
        expect(
          pinned.has(action),
          `${fn} is reachable from ${action}, which is missing from LOCAL_STORE_READ_ACTIONS`
        ).toBe(true);
      }
    }
  });

  it("pins the set relationships: LOCAL_STORE ⊆ EMBEDDED_ONLY ⊆ READ_ACTIONS", () => {
    const embeddedOnly = new Set<string>(EMBEDDED_ONLY_READ_ACTIONS);
    const reads = new Set<string>(READ_ACTIONS);
    for (const action of LOCAL_STORE_READ_ACTIONS) {
      expect(embeddedOnly.has(action)).toBe(true);
    }
    for (const action of EMBEDDED_ONLY_READ_ACTIONS) {
      expect(reads.has(action)).toBe(true);
    }
    // The Meta live-Graph reads are NOT local-store readers and must stay on
    // the daemon surface (founder hard limit: the Meta lane keeps working).
    for (const metaRead of ["list_meta_assets", "list_meta_entities", "get_meta_entity"]) {
      expect(embeddedOnly.has(metaRead)).toBe(false);
    }
  });
});
