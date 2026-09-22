import { afterEach, expect, it, vi } from 'vitest';
import { fetchMetaLiveInsights } from './index.js';
import { MetaAdsRequestTelemetry } from './meta-telemetry.js';

afterEach(() => vi.unstubAllGlobals());
const credential = { mode: 'live', transport: 'marketing_api', adAccountId: '123', accessToken: 'test-token' } as const;
it('persists the sync operation and reservation timestamp before a provider request', async () => {
  const snapshots: Array<Record<string, unknown>> = [];
  const Telemetry = MetaAdsRequestTelemetry as unknown as new (
    limit: number,
    persist: (snapshot: Record<string, unknown>) => Promise<void>,
    deadline?: number,
    onResponse?: unknown,
    operation?: 'inventory_sync' | 'history_sync',
  ) => MetaAdsRequestTelemetry;
  const telemetry = new Telemetry(6, async snapshot => { snapshots.push(snapshot); }, undefined, undefined, 'inventory_sync');
  await telemetry.beforeRequest('account_liveness', false);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toMatchObject({ operation: 'inventory_sync', requestCount: 1 });
  expect(Date.parse(String(snapshots[0]?.lastReservedAt))).not.toBeNaN();
});
it('accounts every live insight and narrow status page before dispatch', async () => {
  const snapshots: number[] = [];
  const telemetry = new MetaAdsRequestTelemetry(4, async s => { snapshots.push(s.requestCount); });
  const urls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(new URL(url));
    expect(snapshots.at(-1)).toBe(urls.length);
    return Response.json({ data: urls.length === 1 ? [{ad_id:'a', spend:'1'}] : [{id:'a', effective_status:'PAUSED'}] });
  }));
  const result = await fetchMetaLiveInsights(credential, {level:'ad', limit:10, includeStatus:true}, telemetry);
  expect(result.rows[0].effectiveStatus).toBe('PAUSED');
  expect(urls[1].searchParams.get('fields')).toBe('id,effective_status');
  expect(urls[1].searchParams.get('limit')).toBe('500');
  expect(telemetry.snapshot().requestCount).toBe(2);
});
it('observes successful headers in native units before accepting the page', async () => {
  const signals: unknown[] = [];
  const telemetry = new MetaAdsRequestTelemetry(4, undefined, undefined, async signal => { signals.push(signal); });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({data:[]}, {headers:{
    'x-fb-ads-insights-throttle': JSON.stringify({app_id_util_pct:65,acc_id_util_pct:4}),
    'x-ad-account-usage': JSON.stringify({acc_id_util_pct:35,reset_time_duration:90,ads_api_access_tier:'standard_access'}),
    'x-business-use-case-usage': JSON.stringify({'123':[{call_count:7,estimated_time_to_regain_access:19}]})
  }})));
  await fetchMetaLiveInsights(credential, {level:'ad',limit:10}, telemetry);
  expect(signals).toEqual([{maxPercent:65,estimatedRegainSeconds:1140,resetSeconds:90,accessTier:'standard_access'}]);
});
it('does not dispatch another page when the durable reservation fails', async () => {
  const telemetry = new MetaAdsRequestTelemetry(4, async s => { if(s.requestCount===2) throw new Error('receipt unavailable'); });
  const fetcher=vi.fn(async () => Response.json({data:[],paging:{next:'https://graph.facebook.com/v25.0/act_123/insights?after=next'}}));
  vi.stubGlobal('fetch', fetcher);
  await expect(fetchMetaLiveInsights(credential,{level:'ad',limit:10},telemetry)).rejects.toThrow('receipt unavailable');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('reserves a logical batch atomically without phantom request units', async () => {
  const snapshots: Array<{requestCount:number;exhausted:boolean}> = [];
  const telemetry = new MetaAdsRequestTelemetry(12, async snapshot => {
    snapshots.push({requestCount:snapshot.requestCount,exhausted:snapshot.budget.exhausted});
  });
  await telemetry.beforeRequests(Array.from({length:11},()=> 'campaign_insights'), false);
  await expect(telemetry.beforeRequests(['campaign_insights','adset_insights'], false))
    .rejects.toMatchObject({code:'provider_rate_budget_exhausted',retryable:true});
  expect(telemetry.snapshot()).toMatchObject({requestCount:11,budget:{remaining:1,exhausted:true}});
  expect(snapshots.at(-1)).toEqual({requestCount:11,exhausted:true});
});
it('accepts a successful hot page once and prevents a subsequent page', async () => {
  const telemetry = new MetaAdsRequestTelemetry(10);
  const fetcher = vi.fn(async () => Response.json({data:[], paging:{next:'https://graph.facebook.com/v25.0/act_123/insights?after=next'}}, {headers:{'x-app-usage':'{"call_count":99}'}}));
  vi.stubGlobal('fetch',fetcher);
  await expect(fetchMetaLiveInsights(credential,{level:'ad',limit:10},telemetry)).rejects.toThrow('cooldown');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(telemetry.snapshot()).toMatchObject({requestCount:1,pageCount:1,retryCount:0});
});
it('awaits throttle signal persistence before any retry, including a low-utilization code17', async () => {
  const signals: unknown[]=[];
  const telemetry = new MetaAdsRequestTelemetry(10,undefined,undefined,async signal=>{signals.push(signal);});
  const fetcher=vi.fn(async()=>Response.json({error:{code:17,estimated_time_to_regain_access:19}}, {status:400}));
  vi.stubGlobal('fetch',fetcher);
  await expect(fetchMetaLiveInsights(credential,{level:'ad',limit:10},telemetry)).rejects.toThrow('cooldown');
  expect(signals).toEqual([{maxPercent:null,estimatedRegainSeconds:1140,resetSeconds:null,accessTier:null,throttled:true}]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects malformed credential API versions before making a request', async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  await expect(fetchMetaLiveInsights({...credential,apiVersion:'v25.0/invalid'},{level:'ad',limit:10})).rejects.toThrow('version');
  expect(fetcher).not.toHaveBeenCalled();
});

it('rejects stored pre-baseline versions without silently upgrading them', async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  await expect(fetchMetaLiveInsights({...credential,apiVersion:'v24.0'},{level:'ad',limit:10})).rejects.toMatchObject({code:'provider_api_version_unsupported',retryable:false});
  expect(fetcher).not.toHaveBeenCalled();
});
