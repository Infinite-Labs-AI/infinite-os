/** Meta ads/adsets accept updated_since (epoch seconds). Campaigns do not expose it in the SDK.
 * The checkpoint is the START of a successfully committed scan, never its finish or last item ID.
 * Overlap tolerates boundary/eventual-consistency lag; a daily full scan reconciles removals.
 */
export function metaEntityReadMode(checkpoint:string|null,fullCheckpoint:string|null,now:Date):{mode:'full'|'incremental';updatedSince?:number;startedAt:string}{
  const startedAt=now.toISOString(),at=now.getTime();
  const last=checkpoint?Date.parse(checkpoint):NaN,full=fullCheckpoint?Date.parse(fullCheckpoint):NaN;
  if(!Number.isFinite(last)||!Number.isFinite(full)||last>at||full>at||at-full>=86_400_000)return {mode:'full',startedAt};
  return {mode:'incremental',updatedSince:Math.max(0,Math.floor(last/1000)-300),startedAt};
}
