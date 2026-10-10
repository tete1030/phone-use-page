import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import statics from '@fastify/static';
import websocket from '@fastify/websocket';
import {chromium} from 'playwright';
import {ScrcpyVideoCodecId} from '@yume-chan/scrcpy';
import {Video} from '../src/video.ts';
import {ParallelWebRtcVideo} from '../src/parallel-webrtc.ts';
import {rtcConfig} from '../src/webrtc.ts';
import {TurnCredentials,loadTurnKey} from '../src/turn-credentials.ts';
import {installWebRtcRoutes} from '../src/webrtc-http.ts';
import {installWssVideoRoute} from '../src/wss-http.ts';
import {render,readAssetVersion} from '../src/ui.ts';
import {annexBNalus} from '../src/h264-rtp.ts';

if(!process.env.COTURN_URL)throw Error('Set COTURN_URL for your own TURN server');
if(process.env.PARALLEL_VIDEO_LIVE!=='1')throw Error('Enable real TURN testing with synthetic video only');
const cfg=rtcConfig({WEBRTC_TURN_PROVIDER:'coturn',COTURN_KEY_FILE:'.local/coturn-key.json',COTURN_URL:process.env.COTURN_URL,COTURN_SERVER_URL:process.env.COTURN_SERVER_URL||process.env.COTURN_URL,WEBRTC_TURN_FALLBACK:'cloudflare',CF_TURN_KEY_FILE:'.local/cloudflare-turn-key.json',WEBRTC_TURN_TTL_SECONDS:'600',VIDEO_WSS_FALLBACK:'1',WEBRTC_PORT_MIN:'50500',WEBRTC_PORT_MAX:'50531'});
const homeKey=await loadTurnKey(cfg.turn),cloudKey=await loadTurnKey(cfg.fallbackTurn),assetVersion=await readAssetVersion();
const ns=annexBNalus(await readFile('.local/coturn-smoke.h264')),frames=[];
for(const n of ns){if((n[0]&31)===9)frames.push([]);if(frames.length)frames.at(-1).push(n);}
const annex=ns=>Buffer.concat(ns.flatMap(n=>[Buffer.from([0,0,0,1]),n]));
const header=annex(ns.filter(n=>[7,8].includes(n[0]&31)).slice(0,2)),cases=[];
const browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
async function scenario(kind){
  const app=Fastify(),owner=randomUUID(),abort=new AbortController(),requests=[];
  const state={connected:true,serial:'synthetic',model:'Parallel synthetic test',android:'fixture',system:'fixture',width:1080,height:2400,rotation:0,screenOn:true,locked:false,powerCollectedAt:Date.now(),snapshotId:'fixture',collectedAt:Date.now(),nodes:[],foregroundApp:'synthetic',focus:null,focusEpoch:0,uiError:null,videoError:null,controlAvailable:true};
  const video=new Video('no-phone',{wssOptimized:true});video.width=432;video.height=960;video.codec=ScrcpyVideoCodecId.H264;video.publishPacket({type:'configuration',data:header});
  let index=0,tick=0,timer;video.client={controller:{resetVideo:async()=>{index=0;}}};
  video.start=async()=>{if(timer)return;timer=setInterval(()=>{const frame=frames[index++%frames.length];video.publishPacket({type:'data',data:annex(frame),keyframe:frame.some(n=>(n[0]&31)===5),pts:BigInt(tick++)*100000n});},100);};
  const cloudRequest=async(url,options)=>{const r=await fetch(url,options);requests.push({operation:url.includes('generate')?'issue':'revoke',status:r.status});return r;};
  const rtc=new ParallelWebRtcVideo(video,cfg,new TurnCredentials(cfg.turn,cfg.stunUrl,homeKey),new TurnCredentials(cfg.fallbackTurn,cfg.stunUrl,cloudKey,cloudRequest));
  await app.register(websocket);await app.register(statics,{root:resolve('dist/web'),prefix:'/assets/'});
  app.get('/',async(_,reply)=>reply.type('text/html').send(await render(state,{basePath:'/',assetVersion,webrtc:rtc.browserConfig,csrf:'fixture',pageId:'fixture',sdk:'fixture',tasks:[],apiMethods:[],ownsControl:false})));
  app.post('/api/connection/connect',async()=>({connectionId:'fixture'}));
  app.get('/api/app-state',async()=>({collectedAt:Date.now(),catalog:{apps:[]},processes:[],navigation:{locked:false,current:null,tasks:[]}}));
  app.post('/api/video/select',async req=>rtc.select(owner,req.body.attemptId));
  app.post('/api/video/cancel',async req=>{await rtc.cancel(owner,req.body.attemptId);return {ok:true};});
  app.post('/fixture/power',async req=>{Object.assign(state,req.body);rtc.setVideoPaused(!state.screenOn||state.locked,!state.screenOn?'screen_off':state.locked?'locked':null);return {...req.body,powerCollectedAt:Date.now()};});
  installWebRtcRoutes(app,p=>p,()=>({owner,connection:{abort}}),rtc);
  let origin;
  installWssVideoRoute(app,p=>p,{session:()=>({owner,connection:{abort}}),originAllowed:o=>o===origin,rtc,video,parallel:rtc,
    pages:{attach:()=>{},requireOwner:o=>{assert.equal(o,owner);}},serialize:work=>work()});
  app.setErrorHandler((e,_,reply)=>reply.code(e.status||500).send({error:{code:e.code,message:e.message}}));
  origin=await app.listen({host:'127.0.0.1',port:0});const context=await browser.newContext({viewport:{width:1919,height:998}});
  await context.addInitScript(({kind,homeUrl})=>{const NativeSocket=window.WebSocket,NativePeer=window.RTCPeerConnection;window.__messages=[];window.__peers=[];window.__fixtureSockets=[];
    if(kind==='manual')localStorage.setItem('android-video-mode','wss');
    window.WebSocket=class {readyState=1;constructor(url){if(url.includes('/ws/video'))return new NativeSocket(url);this.url=url;window.__fixtureSockets.push(this);setTimeout(()=>this.onopen?.({}),0);}send(text){if(this.url.includes('/ws/control'))window.__messages.push(JSON.parse(text));}close(){this.readyState=3;}};
    window.RTCPeerConnection=class extends NativePeer{
      constructor(config){const provider=String(config.iceServers[0].urls)===homeUrl?'coturn':'cloudflare';super(kind==='blocked'?{...config,iceServers:config.iceServers.map(s=>({...s,urls:'turns:127.0.0.1:9?transport=tcp'}))}:config);this.testProvider=provider;window.__peers.push(this);}
      async setLocalDescription(value){if(kind==='upgrade')await new Promise(r=>setTimeout(r,this.testProvider==='coturn'?15000:2500));return super.setLocalDescription(value);}
    };
  },{kind,homeUrl:process.env.COTURN_URL});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));const started=Date.now();
  async function power(screenOn,locked){await page.evaluate(async v=>{const state=await (await fetch('/fixture/power',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(v)})).json();for(const s of window.__fixtureSockets)if(s.url.includes('/ws/events'))s.onmessage?.({data:JSON.stringify({type:'power',...state})});},{screenOn,locked});}
  try{
    await page.goto(origin);await page.locator('.video-network summary').click();
    await page.waitForFunction(()=>Number(document.querySelector('.phone').dataset.framesRendered)>0,{},{timeout:30000});
    const first={provider:await page.locator('.phone').getAttribute('data-video-provider'),elapsedMs:Date.now()-started};
    if(kind==='upgrade'){assert.equal(first.provider,'wss');await page.waitForFunction(()=>document.querySelector('.phone').dataset.videoProvider==='coturn',{},{timeout:30000});}
    else assert.equal(first.provider,'wss');
    await page.waitForTimeout(1000);let details=JSON.parse(await page.locator('.video-network-data').textContent());
    if(kind==='upgrade'){assert.equal(details.browser.provider,'coturn');assert.ok(details.browser.attempts.some(a=>a.provider==='cloudflare'&&a.result==='ready'));assert.ok(details.browser.attempts.some(a=>a.provider==='wss'&&a.result==='ready'));assert.equal(details.server.attempts.length,1);}
    if(kind==='manual')assert.equal(requests.length,0);
    const before=await rtc.diagnostics(owner);await power(false,true);await page.waitForTimeout(700);const paused=await rtc.diagnostics(owner);await page.waitForTimeout(1200);const held=await rtc.diagnostics(owner);assert.equal(held.videoPayloadBytes,paused.videoPayloadBytes);
    await power(true,false);await page.waitForFunction(old=>Number(document.querySelector('.phone').dataset.videoFramesDecoded)>old,Number(await page.locator('.phone').getAttribute('data-video-frames-decoded')),{timeout:10000});
    if(kind==='manual'){await page.locator('[data-video-mode][value=coturn]').check();await page.waitForFunction(()=>document.querySelector('.phone').dataset.videoProvider==='coturn',{},{timeout:20000});assert.equal(requests.length,0);await page.locator('[data-video-mode][value=wss]').check();await page.waitForFunction(()=>document.querySelector('.phone').dataset.videoProvider==='wss',{},{timeout:10000});}
    if(kind==='blocked'){const old=(await rtc.diagnostics(owner)).attemptId;const sockets=[...video.viewers];sockets[0].close(1012,'fixture disconnect');await page.waitForFunction(old=>{try{const d=JSON.parse(document.querySelector('.video-network-data').textContent);return d.browser.provider==='wss'&&d.browser.attemptId!==old&&Number(document.querySelector('.phone').dataset.framesRendered)>0;}catch{return false;}},old,{timeout:12000});}
    const rect=await page.locator('.phone').boundingBox();await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.mouse.down();await page.mouse.move(rect.x+rect.width+80,rect.y+rect.height/2);await page.mouse.up();
    const touches=await page.evaluate(()=>window.__messages.filter(m=>m.type==='touch'));assert.equal(touches.at(-1).action,1);assert.equal(touches.at(-1).x,431);
    assert.deepEqual(errors,[]);const geometry=await page.evaluate(()=>({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight}));assert.ok(geometry.w<=1919&&geometry.h<=998);
    await page.waitForFunction(expected=>{try{return JSON.parse(document.querySelector('.video-network-data').textContent).browser.provider===expected;}catch{return false;}},kind==='upgrade'?'coturn':'wss',{timeout:5000});details=JSON.parse(await page.locator('.video-network-data').textContent());cases.push({kind,first,details,requests,paused,held,pageErrors:errors});console.log(JSON.stringify({kind,first,selected:details.browser.provider,quality:details.server.quality}));
    await page.screenshot({path:'.local/parallel-'+kind+'.png'});
  }catch(e){await writeFile('.local/parallel-live-failure.json',JSON.stringify({kind,error:String(e),errors,diagnostics:await page.locator('.video-network-data').textContent()},null,2)+'\n',{mode:0o600});throw e;}
  finally{await context.close();abort.abort();await rtc.close();video.closeViewers();clearInterval(timer);await app.close();}
}
try{for(const kind of ['blocked','upgrade','manual'])await scenario(kind);await writeFile('.local/parallel-live-result.json',JSON.stringify({passed:true,phoneAccessed:false,syntheticVideo:true,cases},null,2)+'\n',{mode:0o600});}finally{await browser.close();}
