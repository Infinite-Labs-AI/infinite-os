/** Meta ads/adsets accept updated_since (epoch seconds). Campaigns do not expose it in the SDK.
 * The checkpoint is the START of a successfully committed scan, never its finish or last item ID.
 * Overlap tolerates boundary/eventual-consistency lag; a daily full scan reconciles removals.
 */
/** heavyAdFieldsKey is set by extraction when a FULL scan read the ad edge with the heavy field set
 * (see meta-lean-inventory.ts); CLOSE then advances the heavy-reconcile checkpoint.
 * fullReadRequested is set by extraction when an INCREMENTAL scan saw a parent status change it could
 * not propagate to the children (see meta-child-status-refresh.ts); CLOSE then ages the full-read
 * checkpoint so the next scan runs the daily full read. */
export function metaEntityReadMode(checkpoint:string|null,fullCheckpoint:string|null,now:Date):{mode:'full'|'incremental';updatedSince?:number;startedAt:string;heavyAdFieldsKey?:string;fullReadRequested?:string}{
  const startedAt=now.toISOString(),at=now.getTime();
  const last=checkpoint?Date.parse(checkpoint):NaN,full=fullCheckpoint?Date.parse(fullCheckpoint):NaN;
  if(!Number.isFinite(last)||!Number.isFinite(full)||last>at||full>at||at-full>=86_400_000)return {mode:'full',startedAt};
  return {mode:'incremental',updatedSince:Math.max(0,Math.floor(last/1000)-300),startedAt};
}
