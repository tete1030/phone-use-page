if(!process.env.COTURN_URL)throw Error('Set COTURN_URL for your own TURN server');
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import Fastify from 'fastify';
import statics from '@fastify/static';
import websocket from '@fastify/websocket';
import {ScrcpyVideoCodecId} from '@yume-chan/scrcpy';
import {chromium} from 'playwright';
import {Video} from '../src/video.ts';
import {WebRtcVideo,rtcConfig} from '../src/webrtc.ts';
import {TurnCredentials,loadTurnKey} from '../src/turn-credentials.ts';
import {installWebRtcRoutes} from '../src/webrtc-http.ts';
import {installWssVideoRoute} from '../src/wss-http.ts';
import {render,readAssetVersion} from '../src/ui.ts';
import {annexBNalus} from '../src/h264-rtp.ts';

if(process.env.TURN_FALLBACK_LIVE_TEST!=='1')throw Error('Set TURN_FALLBACK_LIVE_TEST=1 to use real TURN credentials with synthetic video. No phone is accessed.');
const config=rtcConfig({WEBRTC_TURN_PROVIDER:'coturn',WEBRTC_ICE_MODE:'relay',WEBRTC_TURN_FALLBACK:'cloudflare',
  WEBRTC_TURN_TTL_SECONDS:'600',COTURN_KEY_FILE:'.local/coturn-key.json',CF_TURN_KEY_FILE:'.local/cloudflare-turn-key.json',
  COTURN_URL:process.env.COTURN_URL,COTURN_SERVER_URL:process.env.COTURN_SERVER_URL||process.env.COTURN_URL,
  WEBRTC_PORT_MIN:'50500',WEBRTC_PORT_MAX:'50531',WEBRTC_ICE_GATHER_MS:'8000',WEBRTC_STUN_URL:'stun:stun.cloudflare.com:443'});
const homeKey=await loadTurnKey(config.turn),cloudKey=await loadTurnKey(config.fallbackTurn);
const nalus=annexBNalus(await readFile('.local/coturn-smoke.h264')),frames=[];
for(const nal of nalus){if((nal[0]&31)===9)frames.push([]);if(frames.length)frames.at(-1).push(nal);}
assert.ok(frames.length>1,'Synthetic fixture needs AUD frame boundaries');
const annex=nals=>Buffer.concat(nals.flatMap(nal=>[Buffer.from([0,0,0,1]),nal]));
const configuration=annex(nalus.filter(nal=>[7,8].includes(nal[0]&31)).slice(0,2));
const state={connected:true,serial:'synthetic',model:'Synthetic TURN test',android:'fixture',system:'fixture',width:1080,height:2400,
  rotation:0,screenOn:true,locked:false,powerCollectedAt:Date.now(),snapshotId:'synthetic',collectedAt:Date.now(),nodes:[],
  foregroundApp:'synthetic',focus:null,focusEpoch:0,uiError:null,videoError:null,controlAvailable:true};
const version=await readAssetVersion(),cases=[];
let browser;
async function runCase(name,forceHomeFailure,forceBothFailure=false,initialPaused=false,enableWss=false){
  const app=Fastify(),owner='synthetic-'+randomUUID(),abort=new AbortController(),apiChecks=[],pending=[];
  const caseState={...state,screenOn:!initialPaused,locked:initialPaused};
  const expectedProvider=enableWss&&forceBothFailure?'wss':forceHomeFailure?'cloudflare':'coturn';
  const request=(url,options)=>{
    const work=fetch(url,options).then(response=>{apiChecks.push({operation:String(url).includes('generate-ice-servers')?'issue':'revoke',status:response.status});return response;});
    pending.push(work);return work;
  };
  let timer,index=0,tick=0;
  const video=new Video('not-a-phone');video.width=432;video.height=960;video.codec=ScrcpyVideoCodecId.H264;video.publishPacket({type:'configuration',data:configuration});
  video.client={controller:{resetVideo:async()=>{index=0;}}};
  video.start=async()=>{if(timer)return;timer=setInterval(()=>{
    const frame=frames[index++%frames.length];
    video.publishPacket({type:'data',data:annex(frame),pts:BigInt(tick++)*100000n,keyframe:frame.some(nal=>(nal[0]&31)===5)});
  },100);};
  const rtc=new WebRtcVideo(video,{...config,wssFallback:enableWss},new TurnCredentials(config.turn,config.stunUrl,homeKey),new TurnCredentials(config.fallbackTurn,config.stunUrl,cloudKey,request));
  rtc.setVideoPaused(initialPaused,initialPaused?'screen_off':null);
  await app.register(websocket);await app.register(statics,{root:resolve('dist/web'),prefix:'/assets/'});
  app.get('/',async(_req,reply)=>reply.type('text/html').send(await render(caseState,{basePath:'/',assetVersion:version,tasks:[],apiMethods:[],csrf:'fixture',pageId:'fixture',sdk:'fixture',ownsControl:false,webrtc:rtc.browserConfig})));
  app.post('/fixture/power',async req=>{Object.assign(caseState,req.body,{powerCollectedAt:Date.now()});rtc.setVideoPaused(!caseState.screenOn||caseState.locked,caseState.screenOn?'locked':'screen_off');return {screenOn:caseState.screenOn,locked:caseState.locked,powerCollectedAt:caseState.powerCollectedAt};});
  app.post('/api/connection/connect',async()=>({connectionId:'fixture'}));
  app.get('/api/app-state',async()=>({collectedAt:Date.now(),catalog:{apps:[]},processes:[],navigation:{locked:false,current:null,tasks:[]}}));
  installWebRtcRoutes(app,p=>p,()=>({owner,connection:{abort}}),rtc);
  let origin;
  installWssVideoRoute(app,p=>p,{session:()=>({owner,connection:{abort}}),originAllowed:value=>value===origin,
    pages:{attach:()=>{},requireOwner:who=>{assert.equal(who,owner);assert.equal(abort.signal.aborted,false);}},rtc,video,serialize:work=>work()});
  app.setErrorHandler((error,_req,reply)=>reply.code(error.status||500).send({error:{code:error.code||'TEST_ERROR',message:error.message}}));
  origin=await app.listen({host:'127.0.0.1',port:0});
  const context=await browser.newContext({viewport:{width:1919,height:998}});
  await context.addInitScript(({forceHomeFailure,forceBothFailure,homeUrl})=>{
    // Control/events are fixtures; media and signaling use the real production implementation.
    window.__fixtureSockets=[];window.__controlMessages=[];const NativeSocket=window.WebSocket;
    window.WebSocket=class {
      readyState=1;
      constructor(url){if(url.includes('/ws/video'))return new NativeSocket(url);this.url=url;window.__fixtureSockets.push(this);setTimeout(()=>this.onopen?.({}),0);}
      send(value){if(this.url.includes('/ws/control'))window.__controlMessages.push(JSON.parse(value));}
      close(){this.readyState=3;}
    };
    if(forceHomeFailure){const Native=window.RTCPeerConnection;window.RTCPeerConnection=class extends Native {
      constructor(config){super({...config,iceServers:config.iceServers.map(server=>(String(server.urls)===homeUrl||forceBothFailure)?{...server,urls:'turns:127.0.0.1:9?transport=tcp'}:server)});}
    };}
  },{forceHomeFailure,forceBothFailure,homeUrl:process.env.COTURN_URL});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.name));
  async function power(screenOn,locked){await page.evaluate(async state=>{const next=await (await fetch('/fixture/power',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(state)})).json();for(const socket of window.__fixtureSockets)if(socket.url.includes('/ws/events'))socket.onmessage?.({data:JSON.stringify({type:'power',...next})});},{screenOn,locked});}
  try {
    if(initialPaused)await page.clock.install();
    await page.goto(origin);await page.locator('.video-network summary').click();
    if(forceBothFailure&&!enableWss){
      await page.waitForFunction(()=>document.querySelector('.video-status').textContent==='视频连接失败，请刷新页面重试',{},{timeout:30000});
      await page.waitForFunction(()=>{try{return JSON.parse(document.querySelector('.video-network-data').textContent).browser.attempts.length===5;}catch{return false;}},{},{timeout:5000});
      const details=JSON.parse(await page.locator('.video-network-data').textContent());
      assert.deepEqual(details.browser.attempts.map(a=>a.provider),['coturn','cloudflare','cloudflare','cloudflare','cloudflare']);
      assert.ok(details.browser.attempts.every(a=>a.result==='failed'));assert.equal(details.server.state,'idle');
      assert.equal(apiChecks.filter(x=>x.operation==='issue').length,2);assert.equal(timer,undefined,'No video source should start without relay candidates');
      await page.waitForTimeout(2000);assert.equal(JSON.parse(await page.locator('.video-network-data').textContent()).browser.attempts.length,5);
      assert.deepEqual(errors,[]);cases.push({name,provider:'cloudflare',details,apiChecks,pageErrors:errors});
      console.log(JSON.stringify({case:name,attempts:5,stopped:true,cloudCredentialIssues:2}));return;
    }
    if(initialPaused){
      await page.waitForFunction(()=>document.querySelector('.phone').dataset.videoConnection==='connected',{},{timeout:30000});
      const initial=await rtc.diagnostics(owner);assert.equal(initial.paused,true);assert.equal(initial.videoPayloadBytes,0);
      await page.clock.fastForward(65000);await page.waitForTimeout(100);
      assert.equal((await rtc.diagnostics(owner)).state,'connected');if(expectedProvider==='coturn')assert.equal(apiChecks.length,0);
      assert.equal(await page.locator('.phone').getAttribute('data-video-provider'),expectedProvider);
      assert.equal(await page.locator('.phone').getAttribute('data-video-paused'),'true');
      await power(true,false);
    }
    await page.waitForFunction(()=>Number(document.querySelector('.phone').dataset.framesRendered)>=10,{},{timeout:80000});
    const provider=await page.locator('.phone').getAttribute('data-video-provider');
    assert.equal(provider,expectedProvider);
    await page.waitForFunction(provider=>{try{const d=JSON.parse(document.querySelector('.video-network-data').textContent);return d.browser.provider===provider&&d.browser.attempts.some(x=>x.result==='playing');}catch{return false;}},provider,{timeout:10000});
    const details=JSON.parse(await page.locator('.video-network-data').textContent());
    assert.equal(details.server.state,'connected');assert.equal(details.server.provider,provider);
    if(provider==='wss'){await Promise.allSettled(pending);assert.equal(details.browser.path,'wss');assert.ok(details.browser.media.decodedAndDrawnFrames>=1);
      assert.deepEqual(details.browser.attempts.map(a=>a.provider),['coturn','cloudflare','wss']);assert.equal(apiChecks.filter(x=>x.operation==='revoke'&&x.status===204).length,2);}
    else{assert.equal(details.browser.selectedPair.local.type,'relay');assert.equal(details.browser.selectedPair.local.relayProtocol,'tls');}
    if(forceHomeFailure){assert.equal(details.browser.attempts[0].provider,'coturn');assert.equal(details.browser.attempts[0].result,'failed');assert.equal(apiChecks.filter(x=>x.operation==='issue').length,2);}
    else assert.equal(apiChecks.length,0,'Healthy Home TURN must not request Cloudflare credentials');
    const before=Number(await page.locator('.phone').getAttribute('data-video-frames-decoded'));await page.waitForTimeout(1500);
    const after=Number(await page.locator('.phone').getAttribute('data-video-frames-decoded'));assert.ok(after>before);
    await power(true,true);await page.waitForTimeout(1000);
    const paused=await rtc.diagnostics(owner),pausedFrames=Number(await page.locator('.phone').getAttribute('data-frames-rendered'));
    assert.equal(paused.paused,true);assert.equal(paused.pauseReason,'locked');
    await page.waitForTimeout(1500);const held=await rtc.diagnostics(owner);
    assert.equal(held.state,'connected');assert.equal(held.videoPayloadBytes,paused.videoPayloadBytes);assert.equal(held.videoPacketsSent,paused.videoPacketsSent);assert.equal(held.videoFrameMessagesSent,paused.videoFrameMessagesSent);
    assert.equal(Number(await page.locator('.phone').getAttribute('data-frames-rendered')),pausedFrames);
    await power(false,true);assert.equal((await rtc.diagnostics(owner)).pauseReason,'screen_off');
    await power(true,false);await page.waitForFunction(old=>Number(document.querySelector('.phone').dataset.framesRendered)>old,pausedFrames,{timeout:10000});
    const resumed=await rtc.diagnostics(owner);assert.equal(resumed.paused,false);assert.ok(resumed.videoPayloadBytes>held.videoPayloadBytes);
    assert.deepEqual(resumed.selectedPair?.local,held.selectedPair?.local,'Pause/resume must keep the local TURN endpoint');
    assert.deepEqual(resumed.selectedPair?.remote,held.selectedPair?.remote,'Pause/resume must keep the remote TURN endpoint');
    if(provider==='wss')assert.equal(await page.locator('.phone').getAttribute('data-video-provider'),'wss');
    if(provider==='wss'){
      const r=await page.locator('.wss-canvas').boundingBox(),v=await page.locator('.video-canvas').boundingBox();
      assert.ok(Math.abs(r.width-v.width)<1&&Math.abs(r.height-v.height)<1,'Video coordinate surface must remain sized under WSS canvas');
      await page.evaluate(()=>window.__controlMessages=[]);await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();
      await page.mouse.move(r.x+r.width+100,r.y+r.height/2);await page.mouse.up();
      const touch=await page.evaluate(()=>window.__controlMessages.filter(m=>m.type==='touch'));
      assert.equal(touch[0].action,0);assert.equal(touch.at(-1).action,1);assert.equal(touch.at(-1).x,431);assert.equal(touch.at(-1).width,432);
      await page.keyboard.press('ArrowDown');const keys=await page.evaluate(()=>window.__controlMessages.filter(m=>m.type==='key'));
      assert.deepEqual(keys.map(k=>k.action),[0,1]);
    }
    assert.deepEqual(errors,[]);
    cases.push({name,provider,framesBefore:before,framesAfter:after,details,paused,held,resumed,initialPaused,apiChecks,pageErrors:errors});
    console.log(JSON.stringify({case:name,provider,framesBefore:before,framesAfter:after,cloudCredentialIssues:apiChecks.filter(x=>x.operation==='issue').length}));
  } catch(error) {
    const text=await page.locator('.video-network-data').textContent().catch(()=>null);
    await writeFile('.local/turn-fallback-live-failure.json',JSON.stringify({name,errorName:error.name,details:text,apiChecks,pageErrors:errors},null,2)+'\n',{mode:0o600});
    throw new Error('Synthetic TURN validation failed: '+name);
  } finally {
    await context.close();abort.abort();await rtc.close();video.closeViewers();clearInterval(timer);await Promise.allSettled(pending);await app.close();
  }
}
try {
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
  if(process.env.WSS_LIVE_ONLY!=='1'){
    await runCase('healthy home has no Cloudflare usage',false);
    await runCase('failed home falls back to actual Cloudflare video',true);
    await runCase('both providers unavailable stops bounded retries',true,true);
    await runCase('initial screen-off keeps connection until wake',false,false,true);
  }
  await runCase('both TURN paths fail and WSS decodes, pauses and resumes',true,true,false,true);
  await runCase('initially off WSS connects without video until wake',true,true,true,true);
  await writeFile(process.env.WSS_LIVE_ONLY==='1'?'.local/wss-interactions-live-result.json':'.local/wss-fallback-live-result.json',JSON.stringify({timestamp:new Date().toISOString(),syntheticVideo:true,phoneAccessed:false,productionChanged:false,passed:true,cases},null,2)+'\n',{mode:0o600});
} finally {await browser?.close();}
