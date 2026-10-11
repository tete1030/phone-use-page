import {readFile,writeFile,mkdir,chmod,access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {build} from 'esbuild';
import {WssEncoder,wssProfiles} from '../src/wss-encoder.ts';
import {annexBNalus} from '../src/h264-rtp.ts';

const exec=promisify(execFile),annex=ns=>Buffer.concat(ns.flatMap(n=>[Buffer.from([0,0,0,1]),n]));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const numberMean=xs=>xs.reduce((a,x)=>a+x,0)/xs.length;

async function capture(out,source,profile,legacy,seconds,ffmpeg) {
  const name=(legacy?'legacy':'fixed')+'-'+profile,p=wssProfiles[profile];
  let executable=ffmpeg;
  if(legacy){
    executable=join(out,name+'-encoder.py');
    const changes=[['-bufsize',String(Math.floor(p.bitRate/3))],['-g',String(p.fps)],['-keyint_min',String(p.fps)],['-x264-params','aud=1:repeat-headers=1']];
    await writeFile(executable,'#!/usr/bin/env python3\nimport sys,os\na=sys.argv[1:]\nfor flag,value in '+JSON.stringify(changes)+':\n a[a.index(flag)+1]=value\nos.execvp('+JSON.stringify(ffmpeg)+',['+JSON.stringify(ffmpeg)+']+a)\n');await chmod(executable,0o700);
  }
  const ns=annexBNalus(source),frames=[];
  for(const n of ns){if((n[0]&31)===9)frames.push([]);if(frames.length)frames.at(-1).push(n);}
  if(!frames.length)throw Error('Synthetic source has no frame boundaries');
  const header=annex(ns.filter(n=>[7,8].includes(n[0]&31)).slice(0,2));
  const started=performance.now(),packets=[],meta=[],chunks=[],wire=[],failures=[],profileChanges=[];
  let index=0,requests=0,first=null,offset=0,timer,rejectRun,snapshot;
  const encoder=new WssEncoder(()=>{requests++;index=0;},executable);encoder.profile=profile;
  encoder.on('profile',value=>profileChanges.push(value));
  encoder.on('failure',error=>{failures.push(error);rejectRun?.(Error(error));});
  encoder.on('packet',packet=>{
    const elapsedMs=performance.now()-started,bytes=Buffer.alloc(10+packet.data.length);
    bytes[0]=packet.type==='configuration'?0:1;bytes[1]=packet.type==='data'&&packet.keyframe?1:0;
    bytes.writeBigUInt64BE(packet.type==='data'?packet.pts:0n,2);bytes.set(packet.data,10);
    packets.push({offset,length:bytes.length,elapsedMs});offset+=bytes.length;wire.push(bytes);chunks.push(Buffer.from(packet.data));
    if(packet.type==='data'){first??=elapsedMs;meta.push({frame:meta.length,keyframe:!!packet.keyframe,bytes:packet.data.length,elapsedMs});}
  });
  try{
    encoder.write({type:'configuration',data:header});encoder.start();
    timer=setInterval(()=>{const ns=frames[index++%frames.length];encoder.write({type:'data',data:annex(ns),keyframe:ns.some(n=>(n[0]&31)===5),pts:BigInt(index)*33333n});},1000/30);
    await Promise.race([wait(seconds*1000),new Promise((_,reject)=>{rejectRun=reject;})]);clearInterval(timer);await wait(300);
  }finally{clearInterval(timer);snapshot={...encoder.snapshot(),...(legacy?{keyframeIntervalSeconds:1,bufferBits:Math.floor(p.bitRate/3)}:{})};encoder.stop();}
  if(failures.length||profileChanges.length||!meta.length)throw Error(name+': encoding failed or profile changed');
  await writeFile(join(out,name+'.h264'),Buffer.concat(chunks));
  await writeFile(join(out,name+'.wire'),Buffer.concat(wire));
  await writeFile(join(out,name+'-packets.json'),JSON.stringify(packets));
  await exec(ffmpeg,['-hide_banner','-loglevel','error','-i',name+'.h264','-loop','1','-i','reference.png','-lavfi',`[0:v]crop=780:1500:40:290[a];[1:v]crop=780:1500:40:290[b];[a][b]ssim=shortest=1:stats_file=${name}-ssim.log`,'-an','-f','null','-'],{cwd:out,timeout:60000});
  const scores=(await readFile(join(out,name+'-ssim.log'),'utf8')).trim().split('\n').map(line=>Number(line.match(/All:([0-9.]+)/)?.[1]));
  if(scores.length!==meta.length)throw Error(name+': decoded and scored frame counts differ');
  const frameQuality=meta.map((m,i)=>({...m,ssim:scores[i]})),steady=frameQuality.filter(m=>m.elapsedMs>=2000);
  const drops=steady.filter(m=>m.keyframe&&m.frame>0).map(m=>frameQuality[m.frame-1].ssim-m.ssim);
  const result={name,profile,legacy,frames:meta.length,firstFrameMs:first,requests,profileChanges,failures,snapshot,
    meanSsim:numberMean(steady.map(m=>m.ssim)),minSsim:Math.min(...steady.map(m=>m.ssim)),maxSsim:Math.max(...steady.map(m=>m.ssim)),
    meanKeyframeDrop:numberMean(drops),maxKeyframeDrop:Math.max(...drops),kbitPerSec:meta.reduce((n,m)=>n+m.bytes,0)*8/(seconds*1000),
    largestFrameBytes:Math.max(...meta.map(m=>m.bytes)),frameQuality};
  await writeFile(join(out,name+'-result.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({...result,frameQuality:undefined}));return result;
}

function html(report) {
  const results=report.results.filter(r=>r.profile===report.results[0].profile),data=JSON.stringify({results}).replaceAll('<','\\u003c');
  const panels=results.map(r=>`<section><h2>${r.legacy?'原参数':'修复参数'} · ${r.profile}</h2><p>最低 SSIM ${r.minSsim.toFixed(4)} · 平均 ${Math.round(r.kbitPerSec)} kbps</p><div class="screen"><canvas id="${r.name}"></canvas></div><p class="stream-status" id="${r.name}-status">等待本地流</p></section>`).join('');
  const w=1100,h=170,x=ms=>50+ms/(report.seconds*1000)*(w-70),y=q=>15+(1-q)/.18*(h-40);
  const lines=results.map((r,i)=>`<polyline fill="none" stroke="${i?'#187b63':'#bd5b35'}" stroke-width="2" points="${r.frameQuality.map(m=>x(m.elapsedMs).toFixed(1)+','+y(m.ssim).toFixed(1)).join(' ')}"/>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WSS 静态文字画质对照</title><style>
  :root{color-scheme:light;--line:#dbe1e9;--ink:#233044}*{box-sizing:border-box}body{margin:0;padding:20px;background:linear-gradient(125deg,#f6f8fc,#eef2f7);color:var(--ink);font:14px 'Noto Sans CJK SC',sans-serif}header{display:flex;align-items:center;gap:16px;flex-wrap:wrap}h1{font-size:24px;margin:0}h2{font-size:16px;margin:0}p{margin:8px 0;color:#58677c}button{font:inherit;padding:5px 12px;background:white;border:1px solid var(--line);border-radius:5px}main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:16px}section{background:white;border:1px solid var(--line);padding:12px;min-width:0}.screen{height:min(59vh,600px);overflow:hidden;background:#f5f6fa;display:flex;justify-content:center;align-items:flex-start}canvas,.screen img{height:100%;width:auto;max-width:100%;object-fit:contain}body.detail .screen{height:360px;display:block}body.detail canvas,body.detail .screen img{width:864px;height:1920px;max-width:none;transform:translate(-40px,-290px)}.chart{margin-top:14px;padding:12px;background:white;border:1px solid var(--line)}svg{width:100%;height:170px}footer{font-size:12px;color:#58677c;margin-top:10px}@media(max-width:850px){main{grid-template-columns:1fr}.screen{height:500px}}
  </style><header><h1>WSS 静态文字画质对照</h1><button id="restart">重新播放</button><button id="pause">暂停保留末帧</button><label><input id="detail" type="checkbox" checked>文字原尺寸局部</label></header><p>合成素材，864×1920；固定档位，无网络限速、无手机连接。两路通过本地 WebSocket 和实际 WSS 播放器解码。</p><main>${panels}<section><h2>原始参考图</h2><p>文字区域以此图作为逐帧评分参考</p><div class="screen"><img src="/reference.png" alt="合成设置页参考图"></div><p>未使用任何设备截图或账户数据</p></section></main><div class="chart"><strong>文字区域 SSIM 随时间变化 · 橙色：原参数，绿色：修复参数</strong><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="原参数周期性下跌，修复参数曲线接近一"><line x1="50" y1="15" x2="50" y2="${h-25}" stroke="#dbe1e9"/><line x1="50" y1="${h-25}" x2="${w-20}" y2="${h-25}" stroke="#dbe1e9"/><text x="0" y="20" font-size="12">1.00</text><text x="0" y="${h-25}" font-size="12">0.82</text>${lines}<text x="${w-95}" y="${h-3}" font-size="12">${report.seconds} 秒</text></svg></div><footer>SSIM 仅比较这一合成素材；不代表所有设备、应用或网络。VBV 容量不是播放缓存，扩大它允许更大的关键帧突发。线上服务未变更。</footer><script id="demo-data" type="application/json">${data}</script><script type="module" src="/player.js"></script><script>document.body.classList.add('detail')</script></html>`;
}

export async function serveQualityDemo(out,report,port=0) {
  await build({entryPoints:['scripts/wss-quality-player.ts'],outfile:join(out,'player.js'),bundle:true,format:'esm',platform:'browser',target:'chrome120'});
  const files=new Map([['/player.js',['player.js','text/javascript']],['/reference.png',['reference.png','image/png']]]);
  const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;if(path==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html(report));return;}const file=files.get(path);if(!file){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':file[1]});res.end(await readFile(join(out,file[0])));}catch{res.writeHead(500);res.end();}});
  const streams=new Map();for(const r of report.results){streams.set(r.name,{wire:await readFile(join(out,r.name+'.wire')),packets:JSON.parse(await readFile(join(out,r.name+'-packets.json'),'utf8'))});}
  const sockets=new WebSocketServer({server,maxPayload:4096});
  sockets.on('connection',(ws,req)=>{
    const name=new URL(req.url,'http://localhost').searchParams.get('case'),stream=streams.get(name);if(!stream){ws.close(1008);return;}
    ws.send(JSON.stringify({type:'metadata',codec:0x68323634,width:864,height:1920}));
    let started=performance.now(),index=0;const first=stream.packets[0].elapsedMs,last=stream.packets.at(-1).elapsedMs;
    const timer=setInterval(()=>{if(ws.readyState!==1)return;const elapsed=performance.now()-started;
      while(index<stream.packets.length&&stream.packets[index].elapsedMs-first<=elapsed){const p=stream.packets[index++];ws.send(stream.wire.subarray(p.offset,p.offset+p.length));}
      if(index===stream.packets.length&&elapsed>last-first+150){started=performance.now();index=0;}
    },10);
    ws.on('message',raw=>{try{const m=JSON.parse(String(raw));if(m.type==='ping')ws.send(JSON.stringify({type:'pong',id:m.id}));}catch{}});
    ws.once('close',()=>clearInterval(timer));
  });
  await new Promise((r,j)=>{server.once('error',j);server.listen(port,'127.0.0.1',r);});
  return {url:'http://127.0.0.1:'+server.address().port,close:async()=>{for(const ws of sockets.clients)ws.terminate();await new Promise(r=>sockets.close(r));await new Promise(r=>server.close(r));}};
}

async function main(){
  const args=process.argv.slice(2),option=(name,fallback)=>args.find(a=>a.startsWith('--'+name+'='))?.split('=').slice(1).join('=')||fallback;
  const out=resolve(option('output','.local/wss-quality-demo')),seconds=Number(option('seconds','16')),profiles=option('profiles','balanced').split(','),ffmpeg=process.env.FFMPEG_PATH||'ffmpeg';
  if(!Number.isFinite(seconds)||seconds<8||seconds>120||profiles.some(p=>!Object.hasOwn(wssProfiles,p)))throw Error('seconds: 8–120; profiles: low,balanced,high');
  await mkdir(out,{recursive:true});let report;
  if(args.includes('--serve-only'))report=JSON.parse(await readFile(join(out,'results.json'),'utf8'));
  else{
    const python=process.env.PYTHON_PATH||await access('.venv/bin/python').then(()=>resolve('.venv/bin/python')).catch(()=> 'python3');
    await exec(python,['scripts/wss-quality-fixture.py',join(out,'reference.png')]);
    await exec(ffmpeg,['-hide_banner','-loglevel','error','-loop','1','-framerate','30','-i',join(out,'reference.png'),'-t','4','-an','-c:v','libx264','-preset','veryfast','-tune','zerolatency','-threads','2','-qp','0','-pix_fmt','yuv420p','-g','60','-bf','0','-x264-params','aud=1:repeat-headers=1','-f','h264','-y',join(out,'source.h264')],{timeout:30000});
    const source=await readFile(join(out,'source.h264')),results=[];
    for(const profile of profiles)for(const legacy of [true,false])results.push(await capture(out,source,profile,legacy,seconds,ffmpeg));
    report={seconds,ffmpegVersion:(await exec(ffmpeg,['-version'])).stdout.split('\n')[0],phoneAccessed:false,networkLimited:false,results};
    await writeFile(join(out,'results.json'),JSON.stringify(report,null,2)+'\n');
    await writeFile(join(out,'report.md'),'# WSS 合成文字画质对照\n\n仅使用合成素材，没有连接手机或在线服务。\n\n| 档位与参数 | 最低 SSIM | 平均 SSIM | 最大关键帧质量下降 | 平均 kbps | 首帧 ms |\n|---|---:|---:|---:|---:|---:|\n'+results.map(r=>`| ${r.name} | ${r.minSsim.toFixed(4)} | ${r.meanSsim.toFixed(4)} | ${r.maxKeyframeDrop.toFixed(4)} | ${Math.round(r.kbitPerSec)} | ${Math.round(r.firstFrameMs)} |`).join('\n')+'\n\n编码首帧耗时不包括公网传输与浏览器显示延迟。VBV 容量不等于网络峰值限制。\n');
    await writeFile(join(out,'demo.html'),html(report));
    console.log('报告：'+join(out,'report.md'));
  }
  if(args.includes('--serve')||args.includes('--serve-only')){const demo=await serveQualityDemo(out,report,Number(option('port','0')));console.log('独立 demo：'+demo.url);const stop=()=>void demo.close().then(()=>process.exit());process.once('SIGINT',stop);process.once('SIGTERM',stop);}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();
