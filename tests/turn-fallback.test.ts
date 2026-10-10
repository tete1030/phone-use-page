import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TurnCredentials,turnConfig,TURN_TLS_URL} from '../src/turn-credentials.js';
import {TurnFallback} from '../src/turn-fallback.js';
import {rtcConfig,WebRtcVideo} from '../src/webrtc.js';
import {Video} from '../src/video.js';

const homeConfig=turnConfig({WEBRTC_TURN_PROVIDER:'coturn',WEBRTC_ICE_MODE:'relay',WEBRTC_TURN_TTL_SECONDS:'600',
  COTURN_KEY_FILE:'fixture',COTURN_URL:'turns:home.example.com:8443?transport=tcp',COTURN_SERVER_URL:'turns:192.0.2.10:5349?transport=tcp'});
const cloudConfig=turnConfig({WEBRTC_TURN_PROVIDER:'cloudflare',CF_TURN_KEY_FILE:'fixture',WEBRTC_TURN_TTL_SECONDS:'600'});
function fixture(){
  let issued=0;const revoked:string[]=[];
  const request:typeof fetch=async(url)=>{
    if(String(url).endsWith('/revoke')){revoked.push(String(url));return new Response(null,{status:204});}
    return new Response(JSON.stringify({iceServers:[{urls:TURN_TLS_URL,username:'user-'+(++issued),credential:'temporary'}]}),{status:201});
  };
  const home=new TurnCredentials(homeConfig,'stun:stun.cloudflare.com:443',{secret:'c'.repeat(64)});
  const cloud=new TurnCredentials(cloudConfig,'stun:stun.cloudflare.com:443',{keyId:'a'.repeat(32),apiToken:'b'.repeat(64)},request);
  return {home,cloud,pool:new TurnFallback(home,cloud),issued:()=>issued,revoked};
}
test('home is first and preparing/renewing it issues no Cloudflare credentials',async()=>{
  const f=fixture(),signal=new AbortController().signal;
  try{const first=await f.pool.prepare('owner',signal);const second=await f.pool.prepare('owner',signal,'coturn');
    assert.deepEqual(first.availableProviders,['coturn','cloudflare']);assert.equal(first.provider,'coturn');assert.equal(first.configId,second.configId);
    assert.equal(f.issued(),0);assert.equal(f.pool.tlsServerName('owner'),'home.example.com');
  }finally{f.pool.release();}
});
test('switching to Cloudflare invalidates home config and changes sender TLS SNI',async()=>{
  const f=fixture(),signal=new AbortController().signal;
  try{const home=await f.pool.prepare('owner',signal);const cloud=await f.pool.prepare('owner',signal,'cloudflare');
    assert.equal(f.issued(),2);assert.equal(cloud.provider,'cloudflare');assert.equal(f.pool.tlsServerName('owner'),'turn.cloudflare.com');
    assert.throws(()=>f.pool.server('owner',home.configId),/过期/);assert.equal(f.pool.server('owner',cloud.configId)[0]!.urls,TURN_TLS_URL);
    assert.throws(()=>f.pool.server('other',cloud.configId),/过期/);
  }finally{f.pool.release();}
});
test('returning to home revokes Cloudflare credentials and rejects its old generation',async()=>{
  const f=fixture(),signal=new AbortController().signal;
  try{const cloud=await f.pool.prepare('owner',signal,'cloudflare');const home=await f.pool.prepare('owner',signal);
    assert.equal(f.revoked.length,2);assert.equal(home.provider,'coturn');assert.throws(()=>f.pool.server('owner',cloud.configId),/过期/);
  }finally{f.pool.release();}
});
test('page cancellation releases only its own provider and prevents reuse',async()=>{
  const f=fixture(),abort=new AbortController();
  try{const cloud=await f.pool.prepare('a',abort.signal,'cloudflare');const home=await f.pool.prepare('b',new AbortController().signal);
    abort.abort();assert.equal(f.revoked.length,2);assert.throws(()=>f.pool.server('a',cloud.configId),/过期/);
    assert.ok(f.pool.server('b',home.configId));await assert.rejects(f.pool.prepare('a',abort.signal),/离线/);
  }finally{f.pool.release();}
});
test('disabled provider requests do not invalidate the active configuration',async()=>{
  const f=fixture(),pool=new TurnFallback(f.home),signal=new AbortController().signal;
  try{const current=await pool.prepare('owner',signal);await assert.rejects(pool.prepare('owner',signal,'cloudflare'),/未启用/);
    assert.ok(pool.server('owner',current.configId));assert.equal(f.issued(),0);
  }finally{pool.release();}
});
test('superseding an in-flight cloud credential request cancels it without resurrecting the old provider',async()=>{
  const f=fixture();let entered!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve);
  const cloud=new TurnCredentials(cloudConfig,'stun:stun.cloudflare.com:443',{keyId:'a'.repeat(32),apiToken:'b'.repeat(64)},async(_url,options)=>{
    entered();return new Promise((_resolve,reject)=>options!.signal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
  });
  const pool=new TurnFallback(f.home,cloud),signal=new AbortController().signal;
  try{const old=pool.prepare('owner',signal,'cloudflare');const rejected=assert.rejects(old,/通道已更换/);await ready;
    const current=await pool.prepare('owner',signal,'coturn');await rejected;assert.equal(current.provider,'coturn');assert.ok(pool.server('owner',current.configId));
  }finally{pool.release();}
});
test('fallback config requires coturn primary, relay policy, and a private cloud key path',()=>{
  const env={WEBRTC_TURN_PROVIDER:'coturn',COTURN_KEY_FILE:'home',COTURN_URL:'turns:home.example.com:8443?transport=tcp',WEBRTC_TURN_FALLBACK:'cloudflare',CF_TURN_KEY_FILE:'cloud'};
  assert.equal(rtcConfig(env).fallbackTurn!.provider,'cloudflare');
  for(const bad of [{...env,WEBRTC_TURN_PROVIDER:'cloudflare'},{...env,WEBRTC_TURN_FALLBACK:'unknown'},{...env,WEBRTC_ICE_MODE:'all'},{...env,CF_TURN_KEY_FILE:''}])assert.throws(()=>rtcConfig(bad));
});
test('provider selection changes cannot start video with a stale generation',async()=>{
  const f=fixture(),config=rtcConfig({WEBRTC_TURN_PROVIDER:'coturn',COTURN_KEY_FILE:'home',COTURN_URL:'turns:home.example.com:8443?transport=tcp',WEBRTC_TURN_FALLBACK:'cloudflare',CF_TURN_KEY_FILE:'cloud'});
  const video=new Video('fixture');let starts=0;video.start=async()=>{starts++;};const rtc=new WebRtcVideo(video,config,f.home,f.cloud),signal=new AbortController().signal;
  try{const home=await rtc.prepare('owner',signal);await rtc.prepare('owner',signal,'cloudflare');
    await assert.rejects(rtc.offer('owner','m=video 9 UDP/TLS/RTP/SAVPF 96\r\n',signal,home.configId),/过期/);assert.equal(starts,0);
    assert.equal((await rtc.diagnostics('owner') as any).provider,'cloudflare');
  }finally{await rtc.close();}
});
test('Cloudflare browser gathering gets a longer budget without changing the home budget',async()=>{
  const f=fixture(),config=rtcConfig({WEBRTC_TURN_PROVIDER:'coturn',COTURN_KEY_FILE:'home',COTURN_URL:'turns:home.example.com:8443?transport=tcp',WEBRTC_TURN_FALLBACK:'cloudflare',CF_TURN_KEY_FILE:'cloud'});
  const rtc=new WebRtcVideo(new Video('fixture'),config,f.home,f.cloud),signal=new AbortController().signal;
  try{assert.equal((await rtc.prepare('owner',signal)).gatherMs,12000);assert.equal((await rtc.prepare('owner',signal,'cloudflare')).gatherMs,45000);}
  finally{await rtc.close();}
});
test('WSS is advertised last without becoming a TURN credential provider',async()=>{
  const f=fixture(),config=rtcConfig({WEBRTC_TURN_PROVIDER:'coturn',COTURN_KEY_FILE:'home',COTURN_URL:'turns:home.example.com:8443?transport=tcp',WEBRTC_TURN_FALLBACK:'cloudflare',CF_TURN_KEY_FILE:'cloud',VIDEO_WSS_FALLBACK:'1'});
  const rtc=new WebRtcVideo(new Video('fixture'),config,f.home,f.cloud),signal=new AbortController().signal;
  try{assert.deepEqual(rtc.browserConfig.availableProviders,['coturn','cloudflare','wss']);assert.deepEqual((await rtc.prepare('owner',signal)).availableProviders,['coturn','cloudflare','wss']);
    await assert.rejects(rtc.prepare('owner',signal,'wss' as any),/未启用/);assert.equal(f.issued(),0);}
  finally{await rtc.close();}
});
