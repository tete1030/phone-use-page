import {connectWssPlayer} from '../src/wss-player.js';

const data=JSON.parse(document.getElementById('demo-data')!.textContent!);
let players:ReturnType<typeof connectWssPlayer>[]=[];
const start=()=>{
  for(const p of players)p.close();players=[];
  for(const result of data.results){
    const canvas=document.getElementById(result.name) as HTMLCanvasElement,status=document.getElementById(result.name+'-status')!;
    status.textContent='正在连接本地测试流';
    const player=connectWssPlayer({url:location.origin.replace('http','ws')+'/stream?case='+encodeURIComponent(result.name),canvas,
      onOpen:()=>{status.textContent='本地 WebSocket 已连接';},onSize:()=>{},onFrame:()=>{status.textContent='已解码 '+player.snapshot().decodedAndDrawnFrames+' 帧';},onFailure:reason=>{status.textContent=reason;}});
    players.push(player);
  }
};
document.getElementById('restart')!.addEventListener('click',start);
document.getElementById('pause')!.addEventListener('click',()=>{for(const p of players)p.close();players=[];document.querySelectorAll('.stream-status').forEach(e=>e.textContent='已暂停，保留末帧');});
document.getElementById('detail')!.addEventListener('change',event=>document.body.classList.toggle('detail',(event.target as HTMLInputElement).checked));
window.addEventListener('pagehide',()=>{for(const p of players)p.close();});
Object.assign(window,{wssQualityDemo:()=>players.map(p=>p.snapshot())});
start();
