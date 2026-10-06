import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { bindMetaAdsCliExecution, createMetaCreative, type MetaCreativeCreateInput } from './index.js';
const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });
function cli() {
 const dir=mkdtempSync(join(tmpdir(),'meta-video-contract-')); dirs.push(dir);
 const executable=join(dir,'meta.mjs'), record=join(dir,'payload.json');
 writeFileSync(executable,`#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2),at=args.indexOf('--object-story-spec');\nif(at<0){process.stderr.write('Uploading video fixture.mp4...\\nError: API error (100): Invalid parameter\\nThe field link_url is not supported in the field video_data of object_story_spec.\\n');process.exit(4);}\nconst story=JSON.parse(args[at+1]);const params={object_story_spec:story};for(const [flag,key] of [['--url-tags','url_tags'],['--degrees-of-freedom-spec','degrees_of_freedom_spec']]){const i=args.indexOf(flag);if(i>=0)params[key]=key==='url_tags'?args[i+1]:JSON.parse(args[i+1]);}\nfs.writeFileSync(${JSON.stringify(record)},JSON.stringify(params));process.stdout.write(JSON.stringify([{id:'456'}]));`);chmodSync(executable,0o700);
 return {credential:bindMetaAdsCliExecution({mode:'live',transport:'meta_ads_cli',adAccountId:'123',accessToken:'fake-token',cliCommand:executable},{mode:'isolated_server',executable}),payload:()=>JSON.parse(readFileSync(record,'utf8'))};
}
const input:MetaCreativeCreateInput={name:'Video',pageId:'222',instagramUserId:'333',videoUrl:'https://media.test/video.mp4',linkUrl:'https://example.test/',title:'Headline',body:'Primary text',description:'Supporting copy',callToAction:'LEARN_MORE',urlTags:'utm_content=video&utm_term={{placement}}',degreesOfFreedomSpec:{creative_features_spec:{text_optimizations:{enroll_status:'OPT_OUT'}}}};
it('submits the complete SDK-valid video payload through CLI raw mode, never its broken video shortcuts',async()=>{
 const command=cli(), requests:Array<{url:string;method:string;body:string}> = [];
 vi.stubGlobal('fetch',async(url:string,init?:RequestInit)=>{
  requests.push({url:String(url),method:init?.method??'GET',body:String(init?.body??'')});
  if(String(url).endsWith('/advideos'))return new Response(JSON.stringify({id:'321'}));
  if(String(url).includes('/321?'))return new Response(JSON.stringify({id:'321',status:{video_status:'ready'},picture:'https://media.test/thumbnail.jpg'}));
  return new Response('fake-video',{headers:{'content-type':'video/mp4'}});
 });
 expect(await createMetaCreative(command.credential,input)).toEqual({ok:true,id:'456',status:null});
 expect(command.payload()).toEqual({object_story_spec:{page_id:'222',instagram_user_id:'333',video_data:{video_id:'321',image_url:'https://media.test/thumbnail.jpg',title:'Headline',message:'Primary text',link_description:'Supporting copy',call_to_action:{type:'LEARN_MORE',value:{link:'https://example.test/'}}}},url_tags:input.urlTags,degrees_of_freedom_spec:input.degreesOfFreedomSpec});
 expect(requests.filter(request=>request.method==='POST')).toHaveLength(1);
 expect(new URLSearchParams(requests[0]!.body).get('file_url')).toBe(input.videoUrl);
});

it('uses the same full payload on native Graph and keeps the token in headers',async()=>{
 const requests:Array<{url:string;init?:RequestInit}>=[];
 vi.stubGlobal('fetch',async(url:string,init?:RequestInit)=>{
  requests.push({url:String(url),init});
  return new Response(JSON.stringify(String(url).endsWith('/advideos')?{id:'321'}:String(url).includes('/321?')?{id:'321',status:{video_status:'ready'},picture:'https://media.test/thumbnail.jpg'}:{id:'456'}));
 });
 expect(await createMetaCreative({mode:'live',transport:'marketing_api',adAccountId:'123',accessToken:'fake-token'},input)).toEqual({ok:true,id:'456',status:null});
 const final=new URLSearchParams(String(requests.at(-1)!.init!.body));
 expect(JSON.parse(final.get('object_story_spec')!)).toMatchObject({page_id:'222',instagram_user_id:'333',video_data:{video_id:'321',image_url:'https://media.test/thumbnail.jpg',link_description:'Supporting copy',call_to_action:{type:'LEARN_MORE',value:{link:input.linkUrl}}}});
 expect(final.get('url_tags')).toBe(input.urlTags);
 for(const request of requests){expect(request.url).not.toContain('fake-token');expect(request.init!.headers).toMatchObject({Authorization:'Bearer fake-token'});}
});
it('chooses a preferred usable thumbnail when the ready node has no picture',async()=>{
 const command=cli();
 vi.stubGlobal('fetch',async(url:string)=>new Response(JSON.stringify(String(url).endsWith('/advideos')?{id:'321'}:String(url).includes('/thumbnails?')?{data:[{uri:'https://media.test/first.jpg'},{uri:'https://media.test/preferred.jpg',is_preferred:true}]}:{id:'321',status:{video_status:'ready'}})));
 await createMetaCreative(command.credential,input);
 expect(command.payload().object_story_spec.video_data.image_url).toBe('https://media.test/preferred.jpg');
});
it('retains the provider processing refusal after upload, redacts it and never creates or retries',async()=>{
 const command=cli(),fetchMock=vi.fn(async(url:string)=>new Response(JSON.stringify(String(url).endsWith('/advideos')?{id:'321'}:{id:'321',status:{video_status:'error',processing_phase:{errors:[{code:100,message:'Readable processing reason fake-token'}]}}})));
 vi.stubGlobal('fetch',fetchMock);
 const error=await createMetaCreative(command.credential,input).catch(error=>error);
 expect(error).toMatchObject({retryable:false,metaWrite:{phase:'dispatch_unknown',outcome:'unknown',providerCode:100,metaMessage:'Readable processing reason [REDACTED]'}});
 expect(fetchMock).toHaveBeenCalledTimes(2);expect(()=>command.payload()).toThrow();
});
it('stops on the first metadata throttle while preserving uploaded-media uncertainty',async()=>{
 const command=cli(),fetchMock=vi.fn(async(url:string)=>String(url).endsWith('/advideos')?new Response(JSON.stringify({id:'321'})):new Response(JSON.stringify({error:{code:17,error_user_msg:'Meta is busy'}}),{status:400}));
 vi.stubGlobal('fetch',fetchMock);
 const error=await createMetaCreative(command.credential,input).catch(error=>error);
 expect(error).toMatchObject({retryable:false,metaWrite:{phase:'dispatch_unknown',outcome:'unknown',providerCode:17,metaMessage:'Meta is busy'}});
 expect(fetchMock).toHaveBeenCalledTimes(2);expect(()=>command.payload()).toThrow();
});
