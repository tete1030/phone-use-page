import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {turnConfig,loadTurnKey,TurnCredentials,TURN_TLS_URL} from '../src/turn-credentials.js';
import {installWebRtcRoutes} from '../src/webrtc-http.js';
import {AuthStore} from '../src/auth.js';
import {installAuth} from '../src/auth-http.js';
import {PageConnections} from '../src/page-connections.js';
import {ConsoleError} from '../src/types.js';
import {rtcConfig,WebRtcVideo} from '../src/webrtc.js';
import {Video} from '../src/video.js';
import {createHmac} from 'node:crypto';

const cfg=turnConfig({WEBRTC_TURN_PROVIDER:'cloudflare',CF_TURN_KEY_FILE:'fixture',WEBRTC_TURN_TTL_SECONDS:'600'});
const key={keyId:'a'.repeat(32),apiToken:'b'.repeat(64)},stun='stun:stun.cloudflare.com:443';
function fixture(){
  let issued=0,now=1000000;const revoked:string[]=[],requests:RequestInit[]=[];
  const request:typeof fetch=async(url,options)=>{
    requests.push(options!);
    if(String(url).endsWith('/revoke')){revoked.push(String(url));return new Response(null,{status:204});}
    const id=++issued;return new Response(JSON.stringify({iceServers:[{urls:['turn:turn.cloudflare.com:3478?transport=udp',TURN_TLS_URL],username:'user-'+id,credential:'short-secret-'+id}]}),{status:201});
  };
  const broker=new TurnCredentials(cfg,stun,key,request,()=>now);
  return {broker,request,requests,revoked,issued:()=>issued,advance:(ms:number)=>{now+=ms;}};
}

test('TURN configuration rejects unsafe or incomplete modes and TTLs',()=>{
  assert.equal(turnConfig({}).provider,'none');assert.equal(cfg.mode,'relay');
  for(const env of [{WEBRTC_TURN_PROVIDER:'unknown'},{WEBRTC_ICE_MODE:'relay'},{WEBRTC_ICE_MODE:'bad'},{WEBRTC_TURN_PROVIDER:'cloudflare'},{WEBRTC_TURN_TTL_SECONDS:'100'},{WEBRTC_TURN_TTL_SECONDS:'172801'}])assert.throws(()=>turnConfig(env));
});
test('TURN key file permissions and parse failures fail without exposing secrets',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phone-turn-key-')),path=join(dir,'key.json');
  try{
    await writeFile(path,JSON.stringify(key),{mode:0o600});assert.deepEqual(await loadTurnKey({...cfg,keyFile:path}),key);
    if(process.platform!=='win32'){await chmod(path,0o644);await assert.rejects(loadTurnKey({...cfg,keyFile:path}),/private file/);await chmod(path,0o600);}
    await writeFile(path,'invalid '+key.apiToken);await assert.rejects(loadTurnKey({...cfg,keyFile:path}),error=>!String(error).includes(key.apiToken));
    await writeFile(path,JSON.stringify({keyId:'https://evil.example',apiToken:key.apiToken}));await assert.rejects(loadTurnKey({...cfg,keyFile:path}),/fields/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('STUN-only mode needs no key or external credential request',async()=>{
  const broker=new TurnCredentials(turnConfig({}),stun,undefined,async()=>{assert.fail('no network');});
  assert.deepEqual(await broker.prepare('owner',new AbortController().signal),{configId:'direct',expiresAt:null,iceServers:[{urls:stun}],iceTransportPolicy:'all'});
  assert.deepEqual(broker.server('owner',undefined),[{urls:stun}]);broker.release();
});
test('concurrent configuration requests coalesce and use separate TLS-only credentials',async()=>{
  const f=fixture(),signal=new AbortController().signal;
  try{
    const [a,b]=await Promise.all([f.broker.prepare('owner',signal),f.broker.prepare('owner',signal)]);
    assert.deepEqual(a,b);assert.equal(f.issued(),2);assert.equal(a.iceServers.length,1);assert.equal(a.iceServers[0]!.urls,TURN_TLS_URL);
    assert.notEqual(a.iceServers[0]!.username,f.broker.server('owner',a.configId)[0]!.username);
    assert.equal(JSON.stringify(a).includes(key.apiToken),false);
    assert.deepEqual(JSON.parse(f.requests[0]!.body as string),{ttl:600,customIdentifier:'owner'});
    assert.equal((f.requests[0]!.headers as Record<string,string>).Authorization,'Bearer '+key.apiToken);
    await f.broker.prepare('owner',signal);assert.equal(f.issued(),2);
  }finally{f.broker.release();}
});
test('another page cannot negotiate with an owner configuration',async()=>{
  const f=fixture();try{const a=await f.broker.prepare('a',new AbortController().signal);assert.throws(()=>f.broker.server('b',a.configId),/过期/);assert.throws(()=>f.broker.server('a','stale'),/过期/);}finally{f.broker.release();}
});
test('credentials rotate before expiry and the old generation is rejected',async()=>{
  const f=fixture(),signal=new AbortController().signal;try{
    const old=await f.broker.prepare('owner',signal);f.advance(300001);const next=await f.broker.prepare('owner',signal);
    assert.notEqual(old.configId,next.configId);assert.equal(f.issued(),4);assert.throws(()=>f.broker.server('owner',old.configId),/过期/);assert.equal(f.revoked.length,2);
    f.advance(600000);assert.throws(()=>f.broker.server('owner',next.configId),/过期/);
  }finally{f.broker.release();}
});
test('disconnect revokes short credentials and removes cached generation',async()=>{
  const f=fixture(),abort=new AbortController();const a=await f.broker.prepare('owner',abort.signal);abort.abort();
  assert.throws(()=>f.broker.server('owner',a.configId),/过期/);assert.equal(f.revoked.length,2);await assert.rejects(f.broker.prepare('owner',abort.signal),/离线/);
});
test('cancellation aborts an in-flight credential request and cannot resurrect the owner',async()=>{
  const abort=new AbortController();let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
  const broker=new TurnCredentials(cfg,stun,key,async(_url,options)=>{started();return new Promise((_resolve,reject)=>options!.signal!.addEventListener('abort',()=>reject(new Error('cancelled secret')),{once:true}));});
  const work=broker.prepare('owner',abort.signal);await ready;abort.abort();await assert.rejects(work,/离线/);assert.throws(()=>broker.server('owner','old'),/过期/);
});
test('upstream failures do not expose response/token and are throttled',async()=>{
  let calls=0;const broker=new TurnCredentials(cfg,stun,key,async()=>{calls++;return new Response('sensitive upstream '+key.apiToken,{status:403});});
  const signal=new AbortController().signal;
  for(let i=0;i<2;i++)await assert.rejects(broker.prepare('owner',signal),error=>error instanceof ConsoleError&&error.code==='TURN_UNAVAILABLE'&&!String(error).includes(key.apiToken));
  assert.equal(calls,1);broker.release();
});
test('oversized, malformed, and missing TLS credential responses are rejected',async()=>{
  for(const text of ['x'.repeat(32769),'not-json',JSON.stringify({iceServers:[{urls:'turn:turn.cloudflare.com:3478?transport=udp',username:'x',credential:'y'}]})]){
    const broker=new TurnCredentials(cfg,stun,key,async()=>new Response(text,{status:201}));try{await assert.rejects(broker.prepare('owner',new AbortController().signal),/中继配置/);}finally{broker.release();}
  }
});
test('partial credential creation failure revokes the issued browser credential',async()=>{
  const f=fixture();let issued=0;
  const broker=new TurnCredentials(cfg,stun,key,async(url,options)=>String(url).endsWith('/revoke')?f.request(url,options):++issued===1?f.request(url,options):new Response(null,{status:503}));
  await assert.rejects(broker.prepare('owner',new AbortController().signal),/中继配置/);assert.equal(f.revoked.length,1);broker.release();
});
test('all mode includes STUN and TLS TURN without changing the relay URL order',async()=>{
  const f=fixture(),broker=new TurnCredentials({...cfg,mode:'all'},stun,key,f.request);try{
    const a=await broker.prepare('owner',new AbortController().signal);assert.equal(a.iceTransportPolicy,'all');assert.equal(a.iceServers[0]!.urls,stun);assert.equal(a.iceServers[1]!.urls,TURN_TLS_URL);
  }finally{broker.release();}
});
test('missing TURN negotiation configuration cannot start phone video',async()=>{
  const f=fixture(),video=new Video('fixture');let started=false;video.start=async()=>{started=true;};
  const rtc=new WebRtcVideo(video,rtcConfig({WEBRTC_TURN_PROVIDER:'cloudflare',CF_TURN_KEY_FILE:'fixture'}),f.broker);
  try{assert.equal(JSON.stringify(rtc.browserConfig).includes('credential'),false);await assert.rejects(rtc.offer('owner','m=video 9 UDP/TLS/RTP/SAVPF 96\r\n',new AbortController().signal,'stale'),/过期/);assert.equal(started,false);}finally{await rtc.close();}
});
test('credential endpoint requires real login, CSRF and the current page before issuance',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phone-turn-http-')),app=Fastify(),store=new AuthStore({password:'fixture-password-for-turn',directory:dir}),pages=new PageConnections();let calls=0;
  await store.init();await app.register(cookie);const auth=installAuth(app,store,{secure:false});
  app.setErrorHandler((e:any,_req,reply)=>reply.code(e.status||500).send({error:{code:e.code,message:e.message}}));
  installWebRtcRoutes(app,p=>p,(req,mutating)=>{const s=auth.authenticate(req,mutating);const c=pages.require(req.headers['x-console-page'],s.id,req.headers['x-console-connection']);return {owner:c.owner,connection:c};},{prepare:async()=>{calls++;return {configId:'fixture'} as any;},offer:async()=>({}) as any,diagnostics:async()=>({})});
  try{
    assert.equal((await app.inject({method:'POST',url:'/api/webrtc/config',payload:{}})).statusCode,401);
    const logged=await store.login('fixture-password-for-turn','fixture'),cookieHeader=auth.cookieName+'='+logged.token;
    const page=pages.issue(logged.session.id),{connection}=pages.begin(page,logged.session.id);pages.complete(connection);
    const headers={cookie:cookieHeader,'x-console-page':page,'x-console-connection':connection.owner};
    assert.equal((await app.inject({method:'POST',url:'/api/webrtc/config',headers,payload:{}})).statusCode,403);
    const valid={...headers,'x-console-csrf':logged.session.csrf};
    assert.equal((await app.inject({method:'POST',url:'/api/webrtc/config',headers:valid,payload:{}})).statusCode,200);assert.equal(calls,1);
    pages.disconnect(connection);assert.equal((await app.inject({method:'POST',url:'/api/webrtc/config',headers:valid,payload:{}})).statusCode,409);assert.equal(calls,1);
  }finally{await app.close();await store.close();await rm(dir,{recursive:true,force:true});}
});

const coturnEnv={WEBRTC_TURN_PROVIDER:'coturn',COTURN_KEY_FILE:'fixture',COTURN_URL:'turns:home.example.com:443?transport=tcp',COTURN_SERVER_URL:'turns:192.168.1.3:5349?transport=tcp',WEBRTC_TURN_TTL_SECONDS:'600'};
test('coturn signs separate expiring HMAC credentials without an external API',async()=>{
  const secret='c'.repeat(64),config=turnConfig(coturnEnv),broker=new TurnCredentials(config,stun,{secret},async()=>{assert.fail('Coturn needs no external API');},()=>1000000);
  try{
    const prepared=await broker.prepare('page-owner',new AbortController().signal),browser=prepared.iceServers[0]!,sender=broker.server('page-owner',prepared.configId)[0]!;
    assert.equal(prepared.expiresAt,1600000);assert.equal(prepared.iceTransportPolicy,'relay');assert.equal(broker.tlsServerName,'home.example.com');
    assert.equal(browser.urls,coturnEnv.COTURN_URL);assert.equal(sender.urls,coturnEnv.COTURN_SERVER_URL);assert.notEqual(browser.username,sender.username);
    for(const credential of [browser,sender]){assert.match(credential.username!,/^1600:page-owner:/);assert.equal(credential.credential,createHmac('sha1',secret).update(credential.username!).digest('base64'));}
    assert.equal(JSON.stringify(prepared).includes(secret),false);
  }finally{broker.release();}
});
test('coturn rejects plaintext, userinfo, invalid port and missing secret configuration',()=>{
  for(const url of ['turn:example.com:443?transport=tcp','turns:user@evil.example:443?transport=tcp','turns:example.com:99999?transport=tcp','turns:example.com:443?transport=udp'])assert.throws(()=>turnConfig({...coturnEnv,COTURN_URL:url}));
  assert.throws(()=>turnConfig({...coturnEnv,COTURN_SERVER_URL:'https://evil.example'}));assert.throws(()=>turnConfig({...coturnEnv,COTURN_KEY_FILE:''}));
});
test('coturn loads only a private valid shared secret file',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phone-coturn-key-')),path=join(dir,'key.json');
  try{await writeFile(path,JSON.stringify({secret:'d'.repeat(64)}),{mode:0o600});assert.deepEqual(await loadTurnKey(turnConfig({...coturnEnv,COTURN_KEY_FILE:path})),{secret:'d'.repeat(64)});await writeFile(path,JSON.stringify({secret:'too-short'}));await assert.rejects(loadTurnKey(turnConfig({...coturnEnv,COTURN_KEY_FILE:path})),/Invalid coturn/);}finally{await rm(dir,{recursive:true,force:true});}
});
test('coturn expiry rotation cannot reuse an old page generation',async()=>{
  let now=1000000;const broker=new TurnCredentials(turnConfig(coturnEnv),stun,{secret:'e'.repeat(64)},fetch,()=>now),signal=new AbortController().signal;
  try{const first=await broker.prepare('owner',signal);now+=300001;const next=await broker.prepare('owner',signal);assert.notEqual(first.configId,next.configId);assert.notEqual(first.iceServers[0]!.username,next.iceServers[0]!.username);assert.throws(()=>broker.server('owner',first.configId),/过期/);}finally{broker.release();}
});
