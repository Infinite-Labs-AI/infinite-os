import type { DetectionState, RunOptions, VerbAction, VerbPlan } from "./types.js";

/**
 * Pure desired-state reconciliation (v6 §9). `detect` already produced `state`;
 * this computes what each remaining verb should do. The caller only EXECUTES verbs
 * the provisioner actually implements (X has no connect/sync; Stripe no setup/implement).
 */
export function reconcile(state: DetectionState, opts: RunOptions = {}): VerbPlan {
  // `state.accountExists` is intentionally NOT consumed here — it's a provisioner-level
  // signal (e.g. GA4 deciding "create account + property" vs "create property only"),
  // not a reconciler decision. (M0 review note.)
  const assetReady = state.assetExists && Boolean(state.assetId);
  const sourceReady = Boolean(state.sourceId);
  const credOk = state.credentialValid === true;

  const setup: VerbAction = assetReady ? "skip" : "run";

  let connect: VerbAction;
  if (!sourceReady) connect = "run";
  else if (!credOk) connect = "repair"; // route to reconnect_source
  else connect = "skip";

  // Skip sync only when the source is connected AND its credential is proven valid.
  const sync: VerbAction = sourceReady && credOk ? "skip" : "run";

  let implement: VerbAction;
  if (opts.skipImplement) implement = "skip";
  else if (state.tagFiring) implement = "skip";
  else if (state.tagInstalled) implement = "repair"; // present but not firing
  else implement = "run";

  return { setup, connect, sync, implement };
}
