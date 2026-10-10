export function videoFreshness(input:{online:boolean;connecting:boolean;pauseReason:string|null;active:boolean;lastFrameAt:number|null;requiredAfter:number;now:number}){
  const age=input.lastFrameAt===null?null:Math.max(0,input.now-input.lastFrameAt);
  const ageText=age===null?'尚未收到画面':`末帧 ${Math.floor(age/1000)} 秒前`;
  const result=(state:string,title:string,detail:string)=>({state,title,detail,lastFrameAgeMs:age,ageText});
  if(!input.online)return result('offline',input.connecting?'正在连接 · 画面未就绪':'已离线 · 画面非实时',ageText);
  if(input.pauseReason){const reason=input.pauseReason==='screen_off'?'手机灭屏':input.pauseReason==='locked'?'手机锁屏':'手机状态未确认';return result('paused','画面已暂停 · 非实时',reason+'；'+ageText);}
  if(!input.active||input.lastFrameAt===null||input.lastFrameAt<input.requiredAfter)return result('waiting','等待新画面 · 尚未就绪',ageText);
  // A still Android screen may produce no frames; silence alone does not prove a broken stream.
  if(age!==null&&age>=5000)return result('unconfirmed','未收到新帧 · 新鲜度未确认',ageText+'；可能画面静止或传输停滞');
  return result('current','画面更新中',ageText);
}
