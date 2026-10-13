import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium} from 'playwright';

// Generate an independent H.264 frame; no phone, production connection or saved personal video.
const h264=execFileSync(process.env.FFMPEG_PATH||'ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=64x64:r=1','-frames:v','1','-c:v','libx264','-profile:v','baseline','-pix_fmt','yuv420p','-f','h264','pipe:1']);
const offsets=[];
for(let i=0;i<h264.length-3;i++)if(h264[i]===0&&h264[i+1]===0&&(h264[i+2]===1||h264[i+2]===0&&h264[i+3]===1)){const prefix=h264[i+2]===1?3:4;offsets.push({at:i,kind:h264[i+prefix]&31});i+=prefix-1;}
const nalus=offsets.map((n,i)=>({...n,bytes:h264.subarray(n.at,offsets[i+1]?.at??h264.length)}));
const configuration=Buffer.concat(nalus.filter(n=>[7,8].includes(n.kind)).map(n=>n.bytes));
const keyframe=Buffer.concat(nalus.filter(n=>![7,8].includes(n.kind)).map(n=>n.bytes));
const bundle=await build({stdin:{contents:"export {connectWssPlayer} from './src/wss-player.ts'; export {ScrcpyVideoCodecId} from '@yume-chan/scrcpy';",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'});
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/player.js'?'text/javascript':'text/html');res.end(req.url==='/player.js'?bundle.outputFiles[0].contents:'<!doctype html><canvas id="screen"></canvas>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,checks=[];let browser;
try {
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
  for(const [mode,stage,code]of [
    ['missing-decoder','capability','WSS_WEB_CODECS_UNAVAILABLE'],
    ['missing-bitmap-context','capability','WSS_BITMAP_RENDERER_UNAVAILABLE'],
    ['unsupported-codec','metadata','WSS_CODEC_UNSUPPORTED'],
    ['invalid-packet','packet','WSS_PACKET_INVALID'],
    ['backpressure','backpressure','WSS_DECODER_BACKPRESSURE'],
    ['decoder-rejection','decode','WSS_DECODE_FAILED'],
    ['render-failure','render','WSS_RENDER_FAILED'],
    ['socket-close','socket','WSS_SOCKET_CLOSED'],
    ['normal-decode',null,null],
    ['normal-close',null,null],
  ]){
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));await page.goto(origin);
    await page.evaluate(async({mode,configuration,keyframe})=>{
      const {connectWssPlayer,ScrcpyVideoCodecId}=await import('/player.js');
      window.__reports=[];window.__failures=[];
      class Socket {readyState=1;constructor(){window.__socket=this;}send(){}close(){this.readyState=3;}}
      window.WebSocket=Socket;
      if(mode==='missing-decoder')delete window.VideoDecoder;
      if(mode==='missing-bitmap-context'){const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,...args){return kind==='bitmaprenderer'?null:original.call(this,kind,...args);};}
      if(mode==='decoder-rejection')window.VideoDecoder=class {state='unconfigured';decodeQueueSize=0;configure(){throw new DOMException('Unsupported codec configuration','NotSupportedError');}close(){this.state='closed';}};
      if(mode==='render-failure')window.createImageBitmap=async()=>{throw new DOMException('Image conversion unavailable','NotSupportedError');};
      window.__player=connectWssPlayer({url:'wss://fixture.invalid/ws/video?connection=never-log-this',canvas:document.querySelector('#screen'),onOpen:()=>{},onSize:()=>{},onFrame:()=>{},
        onFailure:reason=>{window.__failures.push(reason);window.__player.close();},onDiagnostic:report=>window.__reports.push(report)});
      const socket=window.__socket;socket.onopen({});
      if(mode==='normal-close'){window.__player.close();socket.onclose({code:1000,reason:'normal'});return;}
      if(mode==='socket-close'){socket.readyState=3;socket.onclose({code:1006,reason:'closed wss://fixture.invalid/?token=secret-url'});return;}
      socket.onmessage({data:JSON.stringify({type:'metadata',width:64,height:64,codec:mode==='unsupported-codec'?ScrcpyVideoCodecId.H265:ScrcpyVideoCodecId.H264})});
      if(mode==='invalid-packet')socket.onmessage({data:new ArrayBuffer(1)});
      if(mode==='backpressure')for(let i=0;i<3;i++){const packet=new Uint8Array(900000);packet[0]=1;socket.onmessage({data:packet.buffer});}
      if(['decoder-rejection','render-failure','normal-decode'].includes(mode))for(const kind of [0,1]){const bytes=kind===0?configuration:keyframe;const packet=new Uint8Array(bytes.length+10);packet[0]=kind;packet[1]=1;packet.set(bytes,10);socket.onmessage({data:packet.buffer});}
    },{mode,configuration:[...configuration],keyframe:[...keyframe]});
    if(code)await page.waitForFunction(()=>window.__reports.length===1,null,{timeout:8000});
    if(mode==='normal-decode'){
      await page.waitForFunction(()=>window.__player.snapshot().decodedAndDrawnFrames===1);
      assert.equal(await page.locator('#screen').getAttribute('width'),'64');
      assert.equal(await page.locator('#screen').getAttribute('height'),'64');
    }
    const reports=await page.evaluate(()=>window.__reports),failures=await page.evaluate(()=>window.__failures);
    assert.equal(reports.length,code?1:0);assert.equal(failures.length,code?1:0);
    if(code){
      const report=reports[0];assert.equal(report.stage,stage,JSON.stringify(report));assert.equal(report.code,code);assert.equal(report.width,mode==='socket-close'?0:64);
      assert.ok(!JSON.stringify(report).includes('never-log-this'));assert.ok(!JSON.stringify(report).includes('secret-url'));
      if(mode==='decoder-rejection'||mode==='render-failure'){assert.equal(report.error.name,'NotSupportedError');assert.match(report.avcCodec,/^avc1\.[a-f0-9]{6}$/);assert.equal(report.packetsReceived,2);}
      if(mode==='socket-close')assert.equal(report.closeCode,1006);
      assert.deepEqual(await page.evaluate(()=>window.__player.snapshot().lastError),report);
      await page.evaluate(()=>window.__socket.onclose({code:1006,reason:'duplicate'}));assert.equal(await page.evaluate(()=>window.__reports.length),1);
    }
    assert.deepEqual(errors,[]);checks.push(mode);await page.close();
  }
  await mkdir('.local/wss-diagnostics',{recursive:true});
  const report={passed:true,phoneAccessed:false,productionAccessed:false,checks};
  await writeFile('.local/wss-diagnostics/browser-validation.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
