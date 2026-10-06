import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindMetaAdsCliExecution, createMetaAd, createMetaCreative } from './index.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/meta-cli-1.1.0-refusal.json', import.meta.url), 'utf8'));
const videoFixture = JSON.parse(readFileSync(new URL('./fixtures/meta-cli-1.1.0-video-refusal.json', import.meta.url), 'utf8'));
const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function credential(body: string, token = 'fake-secret') {
  const dir = mkdtempSync(join(tmpdir(), 'meta-diagnostic-')); dirs.push(dir);
  const executable = join(dir, 'meta.mjs');
  writeFileSync(executable, `#!${process.execPath}\n${body}\n`); chmodSync(executable, 0o700);
  return bindMetaAdsCliExecution({ mode: 'live', transport: 'meta_ads_cli', adAccountId: '123', accessToken: token, cliCommand: executable }, { mode: 'isolated_server', executable });
}
const ad = { name: 'fixture', adsetId: '456', creativeId: '789' };
async function failure(body: string, token?: string) { return createMetaAd(credential(body, token), ad).catch(error => error); }
describe('Meta write diagnostics at the real subprocess boundary', () => {
  it('extracts the captured video refusal around upload and SDK warnings without claiming no partial processing',async()=>{
    const error=await failure(`process.stderr.write(${JSON.stringify(videoFixture.stderr)});process.exit(4);`);
    expect(error).toMatchObject({code:'provider_api_error',retryable:false,metaWrite:{phase:'dispatch_unknown',outcome:'unknown',providerCode:100,metaMessage:videoFixture.metaMessage,stderr:videoFixture.stderr}});
  });
  it.each(['image','video'])('keeps a pristine API refusal uncertain for an upload-plus-create %s command',async(kind)=>{
    vi.stubGlobal('fetch',async()=>new Response('fake-media',{status:200,headers:{'content-type':kind==='video'?'video/mp4':'image/png'}}));
    const stderr='Error: API error (100): Invalid parameter\n'+videoFixture.metaMessage+'\n';
    const error=await createMetaCreative(credential(`process.stderr.write(${JSON.stringify(stderr)});process.exit(4);`),{name:'fixture',pageId:'222',[kind==='video'?'videoUrl':'imageUrl']:'https://media.test/file',linkUrl:'https://example.com/'}).catch(e=>e);
    expect(error).toMatchObject({code:'provider_api_error',retryable:false,metaWrite:{phase:'dispatch_unknown',outcome:'unknown',providerCode:100,metaMessage:videoFixture.metaMessage}});
  });
  it('excludes trailing SDK deprecation warnings from Meta words',async()=>{
    const stderr=videoFixture.stderr+'WARNING:root:parent_id is being deprecated.\n';
    const error=await failure(`process.stderr.write(${JSON.stringify(stderr)});process.exit(4);`);
    expect(error.metaWrite.metaMessage).toBe(videoFixture.metaMessage);
  });

  it('keeps both error lines emitted by real CLI 1.1.0 during recorded-provider replay', async () => {
    const error = await failure(`process.stderr.write(${JSON.stringify(fixture.stderr)}); process.exit(${fixture.exitCode});`);
    expect(error).toMatchObject({ code: 'meta_provider_rejection', retryable: false, metaWrite: {
      version: 1, phase: 'provider_response', outcome: 'refused', providerCode: 100,
      metaMessage: fixture.providerResponse.error.error_user_msg, stderr: fixture.stderr,
      stdout: '', exitCode: 4, signal: null,
    } });
    // CLI has already discarded these fields: never invent them from the replay's source JSON.
    expect(error.metaWrite.providerSubcode).toBeUndefined();
    expect(error.metaWrite.httpStatus).toBeUndefined();
  });
  it('recognizes an answered throttle without making the write transport retryable', async () => {
    const stderr = 'Error: API error (17): User request limit reached\nPlease wait.\n';
    expect(await failure(`process.stderr.write(${JSON.stringify(stderr)}); process.exit(4);`)).toMatchObject({
      code: 'provider_rate_limited', retryable: false, metaWrite: { phase: 'provider_response', outcome: 'throttled', providerCode: 17, metaMessage: 'Please wait.' },
    });
  });
  it('does not promote error-shaped JSON embedded in provider prose into a rejection', async () => {
    const stderr = 'Unexpected output {"error":{"code":100,"message":"example"}}';
    expect(await failure(`process.stderr.write(${JSON.stringify(stderr)}); process.exit(1);`)).toMatchObject({
      code: 'provider_api_error', metaWrite: { phase: 'dispatch_unknown', outcome: 'unknown', stderr, exitCode: 1 },
    });
  });
  it('preserves process signals and partial output after possible dispatch', async () => {
    expect(await failure(`process.stdout.write('partial'); process.stderr.write('connection lost\\n'); process.kill(process.pid,'SIGTERM');`)).toMatchObject({
      metaWrite: { phase: 'dispatch_unknown', outcome: 'unknown', stdout: 'partial', stderr: 'connection lost\n', exitCode: null, signal: 'SIGTERM' },
    });
  });
  it('proves a missing executable is pre-dispatch', async () => {
    const c = bindMetaAdsCliExecution({ mode: 'live', transport: 'meta_ads_cli', adAccountId: '123', accessToken: 'fake' }, { mode: 'isolated_server', executable: '/nonexistent-meta-test' });
    await expect(createMetaAd(c, ad)).rejects.toMatchObject({ metaWrite: { phase: 'not_dispatched', outcome: 'refused' } });
  });
  it('retains successful CLI output when the provider response has no created id', async () => {
    const error = await failure(`process.stdout.write('{"success":true}'); process.stderr.write('provider returned no id\\n');`);
    expect(error).toMatchObject({ code: 'provider_api_error', metaWrite: { phase: 'dispatch_unknown', outcome: 'unknown', exitCode: 0, stdout: '{"success":true}', stderr: 'provider returned no id\n' } });
  });
  it('redacts secrets before bounding every diagnostic string by JSON byte size', async () => {
    const secret = 'fake-secret', stderr = 'Error: API error (100): '+secret+'\n'+ '中\u0001'.repeat(2000)+' https://host.test/file?token=SIGNED_CAPABILITY';
    const error = await failure(`process.stderr.write(${JSON.stringify(stderr)}); process.exit(4);`, secret);
    expect(error.metaWrite).toBeDefined();
    const json = JSON.stringify(error.metaWrite);
    expect(json).not.toContain(secret); expect(json).not.toContain('SIGNED_CAPABILITY');
    expect(Buffer.byteLength(json)).toBeLessThan(6000);
    expect(error.metaWrite.stderrTruncated).toBe(true);
  });
  it('keeps known HTTP status and subcode from the direct Graph write response', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(fixture.providerResponse), { status: 400 }));
    const error = await createMetaAd({mode:'live',transport:'marketing_api',adAccountId:'123',accessToken:'fake'}, ad).catch(e=>e);
    expect(error).toMatchObject({ status:400, metaWrite:{ phase:'provider_response',outcome:'refused',providerCode:100,providerSubcode:1885272,httpStatus:400,metaMessage:fixture.providerResponse.error.error_user_msg } });
  });

  it('keeps the same real CLI diagnostic on the local CLI write lane', async () => {
    const local = {...credential(`process.stderr.write(${JSON.stringify(fixture.stderr)});process.exit(4);`)};
    await expect(createMetaAd(local, ad)).rejects.toMatchObject({code:'meta_provider_rejection',retryable:false,metaWrite:{stderr:fixture.stderr,exitCode:4,outcome:'refused'}});
  });

});
