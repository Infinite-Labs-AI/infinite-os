import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptCredentialPayload } from '@infinite-os/core';
import { createSessionContext } from '@infinite-os/runtime';
import type { InfiniteOsDb } from '@infinite-os/db';
import { metaPublishingTracking } from '@infinite-os/connectors';
import { createActionHandlers } from './index.js';
const context = createSessionContext({ workspaceId: 'workspace-test', sessionId: 'session-test', actorId: 'actor-test', authority: 'operator', surface: 'api' });
afterEach(() => vi.unstubAllGlobals());
function database(encryptionKey = 'a'.repeat(64)) {
  return { one: vi.fn(async (sql: string) => sql.includes('join connection_credentials') ? {provider:'meta_ads',source_status:'connected',account_external_id:'act_123',credential_id:'credential-test',credential_updated_at:'2026-01-01T00:00:00.000000Z',credential_kind:'api_key',oauth_token_id:null,selected_page_id:'222',encrypted_payload:encryptCredentialPayload({mode:'live',transport:'marketing_api',adAccountId:'123',accessToken:'fake-secret'},encryptionKey)} : sql.includes('insert into meta_write_dedup') ? {id:'claim-test'} : sql.includes('from sources') ? { provider: 'meta_ads', account_external_id: 'act_123' }
    : sql.includes('connection_credentials') ? { credential_kind: 'api_key', oauth_token_id: null, encrypted_payload: encryptCredentialPayload({ mode:'live', transport:'marketing_api', adAccountId:'123', accessToken:'fake-secret' }, encryptionKey) } : null),
    query: vi.fn(async () => []),
  } as unknown as InfiniteOsDb;
}
describe('Meta handler dispatch evidence', () => {
  it('marks handler input validation as not dispatched', async () => {
    const db=database();
    await expect(createActionHandlers(db).create_meta_ad!({},context)).rejects.toMatchObject({ metaWrite: { phase:'not_dispatched', outcome:'refused' } });
    expect(db.one).not.toHaveBeenCalled();
  });
  it('marks an uncoded credential decryption failure as not dispatched', async () => {
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    await expect(createActionHandlers(database(),{ encryptionKey:'b'.repeat(64) }).create_meta_ad!({sourceId:'source-test',adsetId:'456',creativeId:'789',name:'fixture',clientToken:'attempt-test'},context))
      .rejects.toMatchObject({ name:'CredentialDecryptError', metaWrite:{phase:'not_dispatched',outcome:'refused'} });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps a lost Graph response after dispatch uncertain', async () => {
    const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{if(init?.method!=='POST')return new Response(JSON.stringify({id:'789',account_id:'123',url_tags:metaPublishingTracking({linkUrl:'https://example.test'}),object_story_spec:{link_data:{link:'https://example.test'}}}));throw new Error('connection lost');});vi.stubGlobal('fetch',fetch);
    await expect(createActionHandlers(database(),{ encryptionKey:'a'.repeat(64) }).create_meta_ad!({sourceId:'source-test',adsetId:'456',creativeId:'789',name:'fixture',clientToken:'attempt-test'},context))
      .rejects.toMatchObject({metaWrite:{phase:'dispatch_unknown',outcome:'unknown'}});
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
