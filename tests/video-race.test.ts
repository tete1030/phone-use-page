import {test} from 'node:test';
import assert from 'node:assert/strict';
import {VideoRace,type VideoTransport,type RaceHandle} from '../src/video-race.js';
import {ParallelWebRtcVideo} from '../src/parallel-webrtc.js';
import {Video} from '../src/video.js';
import {rtcConfig} from '../src/webrtc.js';
import {TurnCredentials,TURN_TLS_URL} from '../src/turn-credentials.js';
import {randomUUID} from 'node:crypto';

function raceFixture(){const started:{provider:VideoTransport;ready:()=>void;failed:(reason:string)=>void;closed:boolean}[]=[],selected:(VideoTransport|undefined)[]=[],timers:{fn:()=>void;delay:number;cancelled:boolean}[]=[];
  const race=new VideoRace<RaceHandle>(['coturn','cloudflare','wss'],{create:(slot,events)=>{const item={provider:slot.provider,...events,closed:false};started.push(item);return {close:()=>item.closed=true,pauseChanged:()=>{},snapshot:()=>({})};},selected:s=>selected.push(s?.provider),changed:()=>{},schedule:(fn,delay)=>{const t={fn,delay,cancelled:false};timers.push(t);return t;},clear:t=>(t as any).cancelled=true});
  return {race,started,selected,timers,last:(provider:VideoTransport)=>started.filter(x=>x.provider===provider).at(-1)!};}
test('auto starts every path immediately, displays first ready, then promotes higher priority',()=>{const f=raceFixture();f.race.start();assert.deepEqual(f.started.map(x=>x.provider),['coturn','cloudflare','wss']);
  f.last('wss').ready();assert.equal(f.race.active?.provider,'wss');f.last('cloudflare').ready();assert.equal(f.race.active?.provider,'cloudflare');assert.equal(f.last('wss').closed,true);
  f.last('coturn').ready();assert.equal(f.race.active?.provider,'coturn');assert.equal(f.last('cloudflare').closed,true);f.last('coturn').ready();assert.equal(f.selected.filter(x=>x==='coturn').length,1);f.race.stop();});
test('best path failure restarts itself and every fallback in parallel',()=>{const f=raceFixture();f.race.start();f.last('coturn').ready();f.last('coturn').failed('lost');
  assert.deepEqual(f.started.slice(3).map(x=>x.provider),['coturn','cloudflare','wss']);f.last('wss').ready();f.last('coturn').ready();assert.equal(f.race.active?.provider,'coturn');f.race.stop();});
test('manual forces only chosen path and auto can resume upgrading without losing current picture',()=>{const f=raceFixture();f.race.start('wss');assert.deepEqual(f.started.map(x=>x.provider),['wss']);f.last('wss').ready();
  f.race.start('auto');assert.equal(f.race.active?.provider,'wss');assert.deepEqual(f.started.map(x=>x.provider),['wss','coturn','cloudflare']);f.race.start('cloudflare');assert.equal(f.last('wss').closed,true);assert.equal(f.last('coturn').closed,true);
  f.last('cloudflare').ready();assert.equal(f.race.active?.provider,'cloudflare');f.race.stop();});
test('failed higher probes use backoff while keeping lower video, and stale callbacks cannot resurrect',()=>{const f=raceFixture();f.race.start();f.last('wss').ready();const home=f.last('coturn');home.failed('unreachable');
  assert.equal(f.race.active?.provider,'wss');assert.equal(f.timers.at(-1)?.delay,5000);home.ready();assert.equal(f.race.active?.provider,'wss');f.race.stop();assert.ok(f.timers.every(t=>t.cancelled));});
test('credential renewal keeps old media until replacement is ready',()=>{const f=raceFixture();f.race.start('coturn');const old=f.last('coturn');old.ready();f.race.refresh('coturn');assert.equal(old.closed,false);
  f.last('coturn').ready();assert.equal(old.closed,true);assert.equal(f.race.active?.provider,'coturn');f.race.stop();});
test('a held gesture defers promotion until release and still cancels a failed active path',()=>{
  const f=raceFixture();f.race.start();f.last('wss').ready();f.race.holdSelection(true);f.last('cloudflare').ready();f.last('coturn').ready();
  assert.equal(f.race.active?.provider,'wss');assert.equal(f.last('wss').closed,false);f.race.holdSelection(false);assert.equal(f.race.active?.provider,'coturn');
  f.race.holdSelection(true);f.last('coturn').failed('lost');assert.equal(f.race.active,undefined);f.race.holdSelection(false);f.race.stop();
});

function backend(){let issued=0,revoked=0;const config=rtcConfig({WEBRTC_TURN_PROVIDER:'coturn',COTURN_KEY_FILE:'home',COTURN_URL:'turns:home.example.com:8443?transport=tcp',WEBRTC_TURN_FALLBACK:'cloudflare',CF_TURN_KEY_FILE:'cloud',WEBRTC_TURN_TTL_SECONDS:'600',VIDEO_WSS_FALLBACK:'1'});
  const home=new TurnCredentials(config.turn,config.stunUrl,{secret:'a'.repeat(64)}),cloud=new TurnCredentials(config.fallbackTurn!,config.stunUrl,{keyId:'b'.repeat(32),apiToken:'c'.repeat(64)},async url=>{
    if(String(url).endsWith('/revoke')){revoked++;return new Response(null,{status:204});}issued++;return new Response(JSON.stringify({iceServers:[{urls:TURN_TLS_URL,username:'user-'+issued,credential:'temporary'}]}),{status:201});});
  return {rtc:new ParallelWebRtcVideo(new Video('fixture'),config,home,cloud),issued:()=>issued,revoked:()=>revoked};}
test('parallel config identities coexist and cancelling one does not revoke another',async()=>{const f=backend(),signal=new AbortController().signal,home=randomUUID(),cloud=randomUUID();
  try{const [a,b]=await Promise.all([f.rtc.prepare('owner',signal,'coturn',home),f.rtc.prepare('owner',signal,'cloudflare',cloud)]);assert.notEqual(a.configId,b.configId);assert.equal((await f.rtc.diagnostics('owner')).attempts.length,2);
    await f.rtc.cancel('owner',home);assert.equal((await f.rtc.diagnostics('owner')).attempts.length,1);assert.equal(f.revoked(),0);
    await f.rtc.cancel('owner',cloud);assert.equal(f.revoked(),2);
  }finally{await f.rtc.close();}});
test('late prepare for a cancelled attempt is rejected and cannot revive credentials',async()=>{const f=backend(),id=randomUUID();try{await f.rtc.cancel('owner',id);await assert.rejects(f.rtc.prepare('owner',new AbortController().signal,'cloudflare',id),/取消/);assert.equal(f.issued(),0);}finally{await f.rtc.close();}});
test('other owner cannot select or cancel a foreign media candidate',async()=>{const f=backend(),id=randomUUID();try{await f.rtc.prepare('owner',new AbortController().signal,'coturn',id);assert.throws(()=>f.rtc.select('foreign',id),/取消/);await f.rtc.cancel('foreign',id);assert.equal((await f.rtc.diagnostics('owner')).attempts.length,1);}finally{await f.rtc.close();}});
