import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium} from 'playwright';

// Real local H.264 peers exercise the production renderer/manager without ADB, TURN or a page lease.
const bundle=await build({stdin:{contents:"export {createVideoManager} from './src/video-manager.ts'; export {createWebRtcRenderer} from './src/webrtc-renderer.ts';",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'});
const server=createServer((req,res)=>{
  res.setHeader('Content-Type',req.url==='/renderer.js'?'text/javascript':'text/html');
  res.end(req.url==='/renderer.js'?bundle.outputFiles[0].contents:'<!doctype html><body><div id="screen" style="position:relative;width:320px;height:320px"></div></body>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,checks=[];
let browser;
try {
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
  for(const mode of ['canvas','native','constructor-fallback']) {
    const page=await browser.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(String(error)));
    await page.goto(origin);
    await page.evaluate(async mode=>{
      const {createVideoManager}=await import('/renderer.js');
      if(mode==='native')delete window.MediaStreamTrackProcessor;
      if(mode==='constructor-fallback')window.MediaStreamTrackProcessor=class {constructor(){throw new Error('unsupported track');}};
      const nativeFrame=HTMLVideoElement.prototype.requestVideoFrameCallback;
      HTMLVideoElement.prototype.requestVideoFrameCallback=function(fn){return nativeFrame.call(this,(...args)=>{if(!window.__blockPresentation)fn(...args);});};
      const nativeNow=performance.now.bind(performance);window.__clockOffset=0;
      performance.now=()=>nativeNow()+window.__clockOffset;
      const nativeTimeout=window.setTimeout;
      window.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,window.__fastFrameTimeout&&ms===30000?200:ms,...args);
      const source=document.createElement('canvas');source.width=320;source.height=180;
      const context=source.getContext('2d'),stream=source.captureStream(0),track=stream.getVideoTracks()[0];
      window.__source=source;window.__track=track;window.__color='rgb(230,20,20)';window.__paused=false;window.__sourcePaused=false;
      let tick=0;
      const draw=setInterval(()=>{if(window.__sourcePaused)return;context.fillStyle=window.__color;context.fillRect(0,0,source.width,source.height);context.fillStyle='white';context.font='20px monospace';context.fillText(String(++tick),80,80);track.requestFrame();},35);
      const senders=new Map();window.__cancelled=[];window.__offers=0;
      const gather=peer=>new Promise((resolve,reject)=>{
        if(peer.iceGatheringState==='complete')return resolve();
        const timer=setTimeout(()=>reject(new Error('local ICE timeout')),5000);
        const check=()=>{if(peer.iceGatheringState==='complete'){clearTimeout(timer);peer.removeEventListener('icegatheringstatechange',check);resolve();}};
        peer.addEventListener('icegatheringstatechange',check);
      });
      const manager=createVideoManager({providers:['none'],container:document.querySelector('#screen'),paused:()=>window.__paused,
        url:()=>{throw new Error('Unexpected WSS attempt');},selected:()=>{},frame:()=>{},changed:()=>{},
        request:async(path,body)=>{
          if(path==='/api/webrtc/config')return {iceServers:[],iceTransportPolicy:'all',renewAfterMs:null};
          if(path==='/api/webrtc/offer'){
            window.__offers++;
            const sender=new RTCPeerConnection({iceServers:[]});senders.set(body.attemptId,sender);sender.addTrack(track,stream);
            const codecs=RTCRtpSender.getCapabilities('video').codecs.filter(c=>c.mimeType==='video/H264');
            if(!codecs.length)throw new Error('No H.264 codec');sender.getTransceivers()[0].setCodecPreferences(codecs);
            await sender.setRemoteDescription({type:'offer',sdp:body.sdp});await sender.setLocalDescription(await sender.createAnswer());await gather(sender);
            return {type:'answer',sdp:sender.localDescription.sdp,width:source.width,height:source.height};
          }
          if(path==='/api/video/cancel'){
            window.__cancelled.push(body.attemptId);senders.get(body.attemptId)?.close();senders.delete(body.attemptId);
            window.__blockPresentation=false;
            if(window.__fastFrameTimeout){window.__fastFrameTimeout=false;window.__sourcePaused=false;}
          }
          return {};
        }});
      window.__manager=manager;
      window.__cleanup=()=>{manager.stop();clearInterval(draw);track.stop();for(const sender of senders.values())sender.close();};
      manager.start('none');
    },mode);
    await page.waitForFunction(()=>window.__manager.snapshot().current?.framesRendered>=5,null,{timeout:15000});
    let current=await page.evaluate(()=>window.__manager.snapshot().current);
    assert.equal(current.renderer,mode==='canvas'?'track-processor-canvas':'html-video');
    assert.equal(current.width,320);assert.equal(current.height,180);
    assert.equal(await page.locator('.video-candidate').count(),1);
    if(mode==='constructor-fallback')assert.match(current.rendererFallbackReason,/无法读取/);
    if(mode==='canvas') {
      assert.equal(await page.locator('video').count(),0);
      assert.ok(await page.evaluate(()=>document.querySelector('#screen canvas').getContext('2d').getImageData(20,20,1,1).data[0]>180));
      await page.evaluate(()=>window.__color='rgb(20,20,230)');
      await page.waitForFunction(()=>document.querySelector('#screen canvas').getContext('2d').getImageData(20,20,1,1).data[2]>180);
      await page.evaluate(()=>{window.__source.width=180;window.__source.height=320;});
      await page.waitForFunction(()=>window.__manager.snapshot().current?.width===180&&window.__manager.snapshot().current?.height===320);
      assert.equal(await page.locator('#screen canvas').getAttribute('width'),'180');
      await mkdir('.local/video-renderer',{recursive:true});
      await page.screenshot({path:'.local/video-renderer/local-h264-canvas.png'});
      checks.push('real H.264 decode, canvas pixel changes and rotation dimensions without a video element');
    }
    const id=current.attemptId;
    await page.evaluate(()=>window.__sourcePaused=true);
    await page.waitForTimeout(300);
    await page.evaluate(()=>window.__clockOffset+=10000);
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(()=>window.__manager.snapshot().current.attemptId),id);
    await page.evaluate(()=>window.__sourcePaused=false);
    await page.waitForFunction(()=>performance.now()-window.__manager.snapshot().current.lastFrameAt<200);
    assert.equal(await page.evaluate(()=>window.__manager.snapshot().current.attemptId),id);
    checks.push(`${mode}: a still stream and its next new frame do not trigger recovery`);
    await page.evaluate(()=>{window.__paused=true;window.__sourcePaused=true;window.__manager.pauseChanged();});
    await page.waitForTimeout(300);
    const paused=await page.evaluate(()=>window.__manager.snapshot().current.framesRendered);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>window.__manager.snapshot().current.framesRendered),paused);
    await page.evaluate(()=>{window.__paused=false;window.__sourcePaused=false;window.__manager.pauseChanged();});
    await page.waitForFunction(count=>window.__manager.snapshot().current?.framesRendered>count,paused);
    assert.equal(await page.evaluate(()=>window.__manager.snapshot().current.attemptId),id);
    checks.push(`${mode}: pause/resume retains the same real peer and resumes frames`);

    if(mode==='native') {
      await page.waitForFunction(()=>window.__manager.snapshot().current?.media?.framesDecoded>0);
      await page.evaluate(()=>window.__blockPresentation=true);
      await page.waitForTimeout(250);
      await page.evaluate(()=>window.__clockOffset+=10000);
      await page.waitForTimeout(1500);
      await page.evaluate(()=>window.__clockOffset+=10000);
      await page.waitForFunction(old=>window.__manager.snapshot().current?.attemptId&&window.__manager.snapshot().current.attemptId!==old,id,{timeout:10000});
      assert.ok(await page.evaluate(()=>window.__manager.snapshot().history.some(a=>a.result==='failed'&&a.reason.includes('停止绘制'))));
      checks.push('native presentation freeze with real decode progress rebuilds video automatically');
    }
    current=await page.evaluate(()=>window.__manager.snapshot().current);
    await page.evaluate(()=>{window.__paused=true;window.__sourcePaused=true;window.__manager.pauseChanged();});
    await page.waitForTimeout(300);
    await page.evaluate(()=>{window.__fastFrameTimeout=true;window.__paused=false;window.__manager.pauseChanged();});
    await page.waitForFunction(old=>window.__manager.snapshot().current?.attemptId&&window.__manager.snapshot().current.attemptId!==old,current.attemptId,{timeout:10000});
    assert.ok(await page.evaluate(()=>window.__manager.snapshot().history.some(a=>a.result==='failed'&&a.reason.includes('画面未恢复'))));
    checks.push(`${mode}: missing resume frame rebuilds even after frames were previously displayed`);
    await page.evaluate(()=>window.__cleanup());
    assert.equal(await page.locator('.video-candidate').count(),0);
    assert.equal(await page.evaluate(()=>window.__track.readyState),'ended');
    assert.deepEqual(errors,[]);
    await page.close();
  }

  const page=await browser.newPage();await page.goto(origin);
  const teardown=await page.evaluate(async()=>{
    const {createWebRtcRenderer}=await import('/renderer.js');
    let deliver,reads=0,cancels=0,releases=0,painted=0;
    window.MediaStreamTrackProcessor=class {readable={getReader:()=>({read:()=>{reads++;return new Promise(resolve=>deliver=resolve);},cancel:async()=>{cancels++;},releaseLock:()=>releases++})};};
    const source=document.createElement('canvas');source.width=2;source.height=2;
    const track=source.captureStream().getVideoTracks()[0],frame=new VideoFrame(source,{timestamp:1});
    const renderer=createWebRtcRenderer({onFrame:()=>painted++,onFailure:()=>{throw new Error('late failure');}});
    renderer.start(track);renderer.close();deliver({value:frame,done:false});
    await new Promise(resolve=>setTimeout(resolve,0));
    return {reads,cancels,releases,painted,frameClosed:frame.displayWidth===0,trackEnded:track.readyState==='ended'};
  });
  assert.deepEqual(teardown,{reads:1,cancels:1,releases:1,painted:0,frameClosed:true,trackEnded:true});
  checks.push('late frame after close is released without painting, pending reader cancelled and track stopped');
  await mkdir('.local/video-renderer',{recursive:true});
  const result={passed:true,phoneAccessed:false,productionAccessed:false,checks};
  await writeFile('.local/video-renderer/browser-validation.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
