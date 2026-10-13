import {confirmAction} from './confirmation.js';
import { AndroidKeyCode } from '@yume-chan/scrcpy';
import { label, nodeValue, shortId, shownNodes } from './presentation.js';
import type { AndroidNode, Observation, Target } from './types.js';
import { installApplications } from './applications-client.js';
import { normalizeBasePath,consolePath } from './paths.js';
import type {TurnProvider} from './turn-fallback.js';
import {createVideoManager} from './video-manager.js';
import type {VideoMode} from './video-race.js';
import {installTouch} from './touch-client.js';
import {videoFreshness} from './video-freshness.js';
import {currentDraftTarget,focusedTextNode,writableTextNode,refreshWrittenDraftTarget,type DraftTarget} from './text-draft.js';
type VideoProvider=TurnProvider|'wss';
const basePath=normalizeBasePath(document.documentElement.dataset.consoleBase),endpoint=(path:string)=>consolePath(basePath,path);

const login=document.getElementById('login-form') as HTMLFormElement|null;
if(login){
  const reason=sessionStorage.getItem('android-console-login-reason');if(reason){const note=document.createElement('p');note.className='login-note';note.setAttribute('role','status');note.textContent=reason;login.before(note);}
  // A Strict cookie may be withheld on a cross-site navigation but is available here.
  void fetch(endpoint('/api/auth/status')).then(r=>r.json()).then(s=>{if(s.authenticated)location.reload();}).catch(()=>{});
  login.addEventListener('submit',async e=>{e.preventDefault();const values=new FormData(login),button=login.querySelector<HTMLButtonElement>('button')!,status=login.querySelector('output')!;button.disabled=true;status.textContent='正在验证…';try{const response=await fetch(endpoint('/api/login'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:values.get('password'),remember:values.get('remember')==='on',loginToken:values.get('loginToken')})});const result=await response.json();if(response.ok)location.reload();else status.textContent=result.error?.message||'登录失败';}catch{status.textContent='连接失败，请稍后重试';}finally{button.disabled=false;}});
}
else void initialize();

async function initialize() {
  const root=document.getElementById('android-observable')!,app=root.querySelector<HTMLElement>('.app')!;
  const q=<T extends Element=HTMLElement>(s:string)=>root.querySelector<T>(s)!,qa=(s:string)=>root.querySelectorAll<HTMLElement>(s);
  const right=document.createElement('div');right.className='right-shell';right.id='console-tools';app.append(right);
  const workspace=q<HTMLElement>('.workspace'),phonePane=q('.phone-pane');app.prepend(phonePane);
  right.append(q('.topbar'),q('.routing'),q('.connection-note'),workspace);
  q('.routing').append(q('.phone-caption'),q('.video-modes'));
  q('.phone-caption').append(...root.querySelectorAll('.nav [data-panel]'));
  const recent=q('.nav [data-press="RECENTS"]');recent.textContent='任务';recent.setAttribute('aria-label','最近任务');recent.setAttribute('title','最近任务');
  const wake=q('.wake');wake.textContent='唤醒';wake.setAttribute('aria-label','唤醒并解锁');wake.setAttribute('title','唤醒并解锁');
  const keyboardDetails=document.createElement('details');keyboardDetails.className='advanced-input';
  const summary=document.createElement('summary');summary.textContent='原始键盘与更多手势';keyboardDetails.append(summary);
  const keyboardPane=q('.keyboard-command');keyboardDetails.append(q('.capture-buttons'),keyboardPane,q('.clipboard-command'),q('.gesture-command'));q('.commands').style.position='relative';q('.commands').append(keyboardDetails);
  const textContent=document.createElement('div');textContent.className='text-content';
  const textPanel=q('.text-command');textContent.append(...[...textPanel.children].filter(child=>!['section-head','text-toolbar','text-status'].some(name=>child.classList.contains(name))));textPanel.append(textContent,q('.text-toolbar'),q('.text-status'));
  const scriptContent=document.createElement('div');scriptContent.className='script-content';
  const scriptPanel=q('.script-command');scriptContent.append(q('.code-field'),q('.script-note'));scriptPanel.insertBefore(scriptContent,q('.run-toolbar'));
  const process=q('[aria-label="检测到进程"]'),processDetails=document.createElement('details');processDetails.className='process-diagnostics';
  const processSummary=document.createElement('summary');processSummary.textContent='进程诊断（按需展开）';processDetails.append(processSummary,process);q('.applications-panel').append(processDetails);
  let touch:ReturnType<typeof installTouch>|null=null,toolsOpen=false,touchNotice='';
  const mobile=matchMedia('(max-width: 600px)');
  const closeZoom=document.createElement('button');closeZoom.className='close-enlarge';closeZoom.textContent='退出沉浸';closeZoom.addEventListener('click',()=>void exitImmersive());phonePane.append(closeZoom);
  const toolsClose=document.createElement('button');toolsClose.className='mobile-tools-close';toolsClose.textContent='返回手机画面';toolsClose.addEventListener('click',()=>setTools(false));app.append(toolsClose);
  function setTools(open:boolean){touch?.cancel();toolsOpen=open;app.classList.toggle('tools-open',open);q('.mobile-tools').setAttribute('aria-expanded',String(open));right.inert=phonePane.classList.contains('enlarged')||mobile.matches&&!open;phonePane.inert=mobile.matches&&open;
    if(open)toolsClose.focus({preventScroll:true});else{(document.activeElement as HTMLElement)?.blur();q<HTMLButtonElement>('.mobile-tools').focus({preventScroll:true});}fit();}
  async function enterImmersive(){touch?.cancel();setTools(false);(document.activeElement as HTMLElement)?.blur();phonePane.classList.add('enlarged');right.inert=true;fit();
    try{if(document.fullscreenEnabled&&phonePane.requestFullscreen)await phonePane.requestFullscreen();}catch{}
    fit();closeZoom.focus({preventScroll:true});
  }
  async function exitImmersive(){touch?.cancel();phonePane.classList.remove('enlarged');right.inert=mobile.matches&&!toolsOpen;
    try{if(document.fullscreenElement===phonePane)await document.exitFullscreen();}catch{}fit();q<HTMLButtonElement>(mobile.matches?'.mobile-immersive':'.video-enlarge').focus({preventScroll:true});}
  document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&phonePane.classList.contains('enlarged'))void exitImmersive();});
  q('.mobile-tools').addEventListener('click',async()=>{if(phonePane.classList.contains('enlarged'))await exitImmersive();setTools(!toolsOpen);});q('.mobile-immersive').addEventListener('click',()=>void enterImmersive());
  mobile.addEventListener('change',()=>{touch?.cancel('页面布局已变化，手势已释放');right.inert=phonePane.classList.contains('enlarged')||mobile.matches&&!toolsOpen;phonePane.inert=mobile.matches&&toolsOpen;fit();});
  right.inert=mobile.matches;
  const boot=JSON.parse(document.getElementById('console-bootstrap')!.textContent!);
  q('.logout')?.addEventListener('click',async()=>{if(!await confirmAction('退出登录会断开本会话并停止本会话任务，确认退出？'))return;const button=q<HTMLButtonElement>('.logout');button.disabled=true;try{const r=await fetch(endpoint('/api/logout'),{method:'POST',headers:{'Content-Type':'application/json','X-Console-CSRF':boot.csrf},body:'{}'});if(r.ok||r.status===401)location.reload();else{q<HTMLElement>('.connection-note').hidden=false;q('.connection-note').textContent='退出请求未完成，请刷新后重试';}}finally{button.disabled=false;}});
  let observation:Observation=boot.state,ownsControl=boot.ownsControl,controlAllowed=true,taskBusy=false,appsBusy=false,filter='compact',query='';
  let applications:ReturnType<typeof installApplications>|undefined;
  let online=false,connecting=false,connectionId='',connectionEpoch=0,networkAbort=new AbortController(),needsRefresh=false,waking=false,eventsSocket:WebSocket|null=null;
  let recovering=false,transportReady=false,readySignal=false,transportGeneration=0,recoverySince=0,recoveryAttempt=0,lastControlMessage=0,lastEventsMessage=0;
  let recoveryTimer:ReturnType<typeof setTimeout>|undefined,handshakeTimer:ReturnType<typeof setTimeout>|undefined,recoveryDeadline:ReturnType<typeof setTimeout>|undefined;
  let inspected:{node:AndroidNode;snapshotId:string}|null=null;
  let draftTarget:DraftTarget|null=null,dirty=false,textPending=false,textNotice='';
  let writtenDraft:{target:DraftTarget;value:string;epoch:number;until:number}|null=null;
  let currentTask:any=boot.tasks[0]||null,keyMode='letters',control:WebSocket|null=null;
  let meta={width:0,height:0,codec:0};
  let networkInfo:unknown=null,networkLoading=false;
  let videoProvider:VideoProvider|undefined;
  const providerName=(provider:VideoProvider|undefined)=>provider==='coturn'?'自建 TURN':provider==='cloudflare'?'Cloudflare TURN':provider==='wss'?'WSS':'直连 WebRTC';
  const powerKnown=()=>!observation.powerError&&!!observation.powerCollectedAt&&Date.now()-observation.powerCollectedAt<=10000;
  const videoPaused=()=>!powerKnown()||!observation.screenOn||observation.locked!==false;
  const videoPauseReason=()=>!powerKnown()?'power_unknown':!observation.screenOn?'screen_off':observation.locked!==false?'locked':null;
  let videoManager:ReturnType<typeof createVideoManager>|null=null;
  let lastDisplayedFrameAt:number|null=null,frameRequiredAfter=0,previousVideoPaused=true;
  const savedMode=localStorage.getItem('android-video-mode');
  const videoProviders:VideoProvider[]=boot.webrtc?.availableProviders||['none'];
  let videoMode:VideoMode=savedMode&&(savedMode==='auto'||videoProviders.includes(savedMode as VideoProvider))?savedMode as VideoMode:'auto';
  const canvas=q<HTMLVideoElement>('.video-canvas'),phone=q<HTMLButtonElement>('.phone'),editor=q<HTMLTextAreaElement>('.code-input'),text=q<HTMLTextAreaElement>('.text-input');
  const textTargetSelect=q<HTMLSelectElement>('.text-target');
  const jitterToggle=q<HTMLInputElement>('.click-jitter');jitterToggle.checked=localStorage.getItem('android-click-jitter')!=='false';
  const clickOptions=()=>({jitter:jitterToggle.checked});
  jitterToggle.addEventListener('change',()=>localStorage.setItem('android-click-jitter',String(jitterToggle.checked)));
  const wssCanvas=q<HTMLCanvasElement>('.wss-canvas');
  const rows=new Map<string,{li:HTMLLIElement;button:HTMLButtonElement;num:HTMLElement;branch:HTMLElement;label:HTMLElement;value:HTMLElement;children:HTMLUListElement}>();
  q('.node-list').replaceChildren();
  const assign=(el:Element,value:string)=>{if(el.textContent!==value)el.textContent=value;};
  const target=(n:AndroidNode):Target=>({id:n.id,fingerprint:n.fingerprint,snapshotId:observation.snapshotId});
  const url=(path:string)=>{const u=new URL(endpoint(path),location.href);u.searchParams.set('page',boot.pageId);u.searchParams.set('connection',connectionId);u.searchParams.set('generation',String(transportGeneration));return u.toString().replace(/^http/,'ws');};
  const viewUrl=(path:string)=>{const u=new URL(endpoint(path),location.href);u.searchParams.set('page',boot.pageId);u.searchParams.set('connection',connectionId);return u.pathname+u.search;};
  const interactive=()=>online&&transportReady&&!waking&&powerKnown()&&observation.screenOn&&observation.locked===false;
  function touchBlockedReason(){
    if(!online)return '本页已离线';
    if(waking)return '正在唤醒并解锁';
    if(!powerKnown())return '手机状态尚未确认';
    if(!observation.screenOn||observation.locked!==false)return '手机息屏或锁屏';
    if(control?.readyState!==1||!observation.controlAvailable)return '手机控制通道尚未就绪';
    if(taskBusy||appsBusy||textPending||!controlAllowed)return '设备正在处理其他操作';
    if(!videoManager?.active()||!Number.isFinite(meta.width)||!Number.isFinite(meta.height)||meta.width<=0||meta.height<=0)return '视频坐标尚未就绪';
    return null;
  }
  // Frame freshness is a display warning, not an input gate: a still screen may
  // need a touch before producing another frame after unlock.
  const touchReady=()=>touchBlockedReason()===null;
  function fit(){touch?.cancel(touch.active()?'页面尺寸已变化，手势已释放':undefined);app.style.transform='none';root.style.width='100%';root.style.height=(visualViewport?.height||innerHeight)+'px';fitPhone();}
  addEventListener('resize',fit);addEventListener('orientationchange',fit);visualViewport?.addEventListener('resize',fit);
  function fitPhone(){if(touch?.active())return;const stage=q<HTMLElement>('.phone-stage');const ratio=meta.width&&meta.height?meta.width/meta.height:observation.width/observation.height;
    if(!Number.isFinite(ratio)||ratio<=0)return;
    if(!mobile.matches)app.style.setProperty('--phone-column',Math.min(innerWidth*.46,(innerHeight-52)*ratio+16)+'px');
    const height=Math.max(0,Math.min(stage.clientHeight-6,(stage.clientWidth-6)/ratio));phone.style.height=height+'px';phone.style.width=height*ratio+'px';}
  fit();
  new ResizeObserver(fitPhone).observe(q('.phone-stage'));
  async function api(path:string,data?:unknown){if(!online)throw new Error('PAGE_OFFLINE: 本页已离线');const epoch=connectionEpoch;
    const response=await fetch(endpoint(path),{method:data===undefined?'GET':'POST',headers:{'X-Console-Page':boot.pageId,'X-Console-Connection':connectionId,'X-Console-Generation':String(transportGeneration),...(data===undefined?{}:{'Content-Type':'application/json','X-Console-CSRF':boot.csrf})},body:data===undefined?undefined:JSON.stringify(data),signal:networkAbort.signal});
    const result=await response.json();if(!online||epoch!==connectionEpoch)throw new Error('PAGE_OFFLINE: 连接已更换');
    if(!response.ok){if(result.error?.code==='CONNECTION_RECOVERING')beginRecovery();else if(result.error?.code==='PAGE_OFFLINE')goOffline('本页连接已失效，请重新连接');else if(['LOGIN_REQUIRED','IDLE_TIMEOUT'].includes(result.error?.code))goOffline(offlineReason(result.error.code));throw new Error(result.error?.code+': '+result.error?.message);}return result;
  }
  function log(message:string){if(!online)return;const row=document.createElement('div');row.className='log-line';const prefix=document.createElement('span');prefix.className='log-time';prefix.textContent=new Date().toLocaleTimeString('zh-CN',{hourCycle:'h23',hour:'2-digit',minute:'2-digit',second:'2-digit'});const content=document.createElement('span');content.className='log-message';content.textContent=message;row.append(prefix,content);q('.results').prepend(row);q('.results').scrollTop=0;while(q('.results').children.length>100)q('.results').lastChild?.remove();}
  async function perform(path:string,data:any){try{const result=await api(path,{requestId:crypto.randomUUID(),...(path==='/api/node'?{clickOptions:clickOptions()}:{}),...data});const names:Record<string,string>={'/api/node':data.action==='setText'?'填写文字':data.action==='focus'?'聚焦输入框':data.action==='click'?'点击':'节点动作','/api/press':'手机按键','/api/gesture':data.kind||'手势','/api/wake':'唤醒并解锁','/api/panel':data.kind==='notifications'?'展开通知栏':'展开控制中心','/api/apps/open':'打开应用','/api/android-tasks/switch':'切换任务','/api/navigation/back':'连续返回'};log((names[path]||path)+' · '+(data.key||data.packageName||data.target?.id||data.taskId||'')+' · '+(result.verification==='verified'?'效果已验证':result.verification==='failed'?'验证失败':result.verification==='inconclusive'?'无法确认效果':'已发送，未验证'));const detail=document.createElement('details'),title=document.createElement('summary'),pre=document.createElement('pre');title.textContent='技术详情';pre.textContent=JSON.stringify(result,null,2);detail.append(title,pre);q('.results').firstChild?.appendChild(detail);return result;}catch(error){log(String(error));throw error;}}
  applications=installApplications(root,{api,perform,canAct:()=>interactive()&&controlAllowed&&!appsBusy&&!touch?.active(),online:()=>online,busyChanged:busy=>{appsBusy=busy;textState();details();}});
  function chooseTextTarget(node:AndroidNode|null,source:DraftTarget['source']='selected'){
    draftTarget=node?{node:structuredClone(node),windowId:observation.windowId,source}:null;textNotice='';textState();
  }
  function textState(message?:string){
    if(message!==undefined)textNotice=message;
    if(writtenDraft){
      if(writtenDraft.target!==draftTarget||writtenDraft.epoch!==connectionEpoch||performance.now()>writtenDraft.until||observation.windowId!==writtenDraft.target.windowId)writtenDraft=null;
      else{const refreshed=refreshWrittenDraftTarget(observation,writtenDraft.target,writtenDraft.value);if(refreshed){draftTarget=refreshed;writtenDraft=null;}
        else if(writtenDraft.target.source==='focus'&&focusedTextNode(observation)?.id!==writtenDraft.target.node.id)writtenDraft=null;}
    }
    if(!dirty&&!textPending&&(!draftTarget||draftTarget.source==='focus')){const node=focusedTextNode(observation);draftTarget=node?{node:structuredClone(node),windowId:observation.windowId,source:'focus'}:null;}
    const fields=observation.nodes.filter(writableTextNode),ids=new Set(fields.map(n=>n.id));
    for(const option of [...textTargetSelect.options])if(option.value&&!ids.has(option.value)&&option.value!==draftTarget?.node.id)option.remove();
    for(const node of fields){let option=[...textTargetSelect.options].find(o=>o.value===node.id);if(!option){option=document.createElement('option');option.value=node.id;textTargetSelect.append(option);}assign(option,label(node,observation.nodes)+' · '+(node.resourceId||node.className));option.disabled=false;}
    if(draftTarget&&!ids.has(draftTarget.node.id)){let option=[...textTargetSelect.options].find(o=>o.value===draftTarget!.node.id);if(!option){option=document.createElement('option');option.value=draftTarget.node.id;textTargetSelect.append(option);}assign(option,'原目标已不可用');option.disabled=true;}
    textTargetSelect.value=currentDraftTarget(observation,draftTarget)?draftTarget!.node.id:'';textTargetSelect.disabled=!online||textPending||taskBusy;
    const node=currentDraftTarget(observation,draftTarget),ready=interactive()&&!!node&&controlAllowed&&!appsBusy&&!textPending&&!writtenDraft&&!taskBusy&&!touch?.active();
    q<HTMLButtonElement>('.text-submit').disabled=!ready;q<HTMLButtonElement>('.text-read').disabled=!ready;
    assign(q('.text-target-status'),draftTarget?'填写到：'+label(draftTarget.node,observation.nodes):'请选择手机输入字段');
    assign(q('.text-status'),!online?'本页已离线，草稿保留':!interactive()?'手机状态不可操作，草稿保留':textPending?'正在处理文字请求；不会自动重试':writtenDraft?textNotice+'；等待输入框最新快照':!node&&draftTarget?(textNotice&&!textNotice.startsWith('草稿')?textNotice+'；目标已改变，请重新选择':'目标已改变，请重新选择；草稿保留'):textNotice||(!node?'请选择输入字段；仅有一个手机文字焦点时会自动选中':'网页内容仅为草稿，点击“填写到手机”才会替换原文'));
    inputAvailability();
  }
  function inputAvailability(){phone.disabled=!online||!transportReady||taskBusy||appsBusy;text.readOnly=textPending;q<HTMLButtonElement>('.video-reconnect').disabled=!online;const blocked=!!touch?.active()||!interactive()||(!controlAllowed||appsBusy)||!observation.controlAvailable;q('.keys')?.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=blocked);qa('[data-press],[data-gesture],[data-mode],[data-panel]').forEach(b=>(b as HTMLButtonElement).disabled=blocked);q<HTMLButtonElement>('.run').disabled=!online||!transportReady||taskBusy||!!touch?.active();q<HTMLButtonElement>('.check-code').disabled=!online||taskBusy;details();route();}
  function route(){const active=document.activeElement,ready=interactive()&&!!control&&control.readyState===1&&observation.controlAvailable&&controlAllowed&&!appsBusy, captured=active===phone&&ready;
    const focus=active===phone?'手机画面':active===text?'文本输入框':active===editor?'JS 编辑框':active===q('.node-search')?'元素搜索框':'网页';
    q('.routing').classList.toggle('captured',captured);assign(q('.focus-target'),focus);assign(q('.key-target'),captured?'手机按键':'网页');assign(q('.keyboard-backend'),observation.keyboardBackend==='uhid'?'原始键盘：UHID':'原始键盘：兼容按键；推荐文字直达');assign(q('.capture-status'),!online?'已离线':captured?'键盘输入手机 · Esc 退出':active===phone?'手机暂不可输入':'键盘留在网页');
    q<HTMLButtonElement>('.capture').disabled=!ready;q<HTMLButtonElement>('.release').disabled=!online;assign(q('.owner-state'),online&&taskBusy?'批量操作执行中':'');
    applications?.controlsChanged();
  }
  function renderNodes(){const source=observation,display=shownNodes(source.nodes,filter,query),wanted=new Set(display.map(n=>n.id)),positions=new Map<Element,number>();
    q<HTMLElement>('.snapshot-warning').hidden=!observation.uiError;
    rows.forEach((row,id)=>{if(!wanted.has(id)){row.li.remove();rows.delete(id);}});
    for(const n of display){let row=rows.get(n.id);if(!row){const li=document.createElement('li'),button=document.createElement('button');button.type='button';button.className='node-button';li.dataset.nodeId=n.id;
      const num=document.createElement('span');num.className='node-code';const branch=document.createElement('span');branch.className='node-branch';branch.setAttribute('aria-hidden','true');
      const name=document.createElement('span'),value=document.createElement('span');name.className='node-label';value.className='node-value';button.append(num,branch,name,value);li.append(button);row={li,button,num,branch,label:name,value,children:document.createElement('ul')};rows.set(n.id,row);button.addEventListener('click',()=>inspect(n.id));}
      assign(row.num,shortId(n,source.nodes)+' ');assign(row.branch,n.clickable||n.editable||n.checkable?'↳':'▾');row.branch.style.marginLeft=Math.min(n.depth,8)*10+'px';assign(row.label,label(n,source.nodes));assign(row.value,' '+nodeValue(n));row.button.classList.toggle('is-inspected',inspected?.node.id===n.id);
      const parent=rows.get(n.parentId||'');let container:Element=q('.node-list');if(parent&&wanted.has(n.parentId!)){if(parent.children.parentNode!==parent.li)parent.li.append(parent.children);container=parent.children;}
      const index=positions.get(container)||0;if(container.children[index]!==row.li)container.insertBefore(row.li,container.children[index]||null);positions.set(container,index+1);
    }
    rows.forEach(row=>{if(!row.children.children.length)row.children.remove();});assign(q('.count'),display.length+' 条节点');
    assign(q('.snapshot-version'),source.snapshotId||'等待元素数据');
    assign(q('.ui-status'),observation.uiError?'元素暂不可用；保留上次观察':'元素自动更新');qa('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.filter===filter)));details();
  }
  function inspect(id:string){const source=observation,n=source.nodes.find(n=>n.id===id);if(!n)return;if(writableTextNode(n)&&!textPending)chooseTextTarget(n);inspected={node:structuredClone(n),snapshotId:source.snapshotId};rows.forEach((row,key)=>row.button.classList.toggle('is-inspected',key===id));details();}
  function details(){if(inspected){const latest=observation.nodes.find(n=>n.id===inspected!.node.id);if(latest&&(latest.resourceId?latest.resourceId===inspected.node.resourceId&&latest.package===inspected.node.package:latest.className===inspected.node.className)&&JSON.stringify(latest.bounds)===JSON.stringify(inspected.node.bounds)&&(latest.editable||latest.text===inspected.node.text)){inspected={node:structuredClone(latest),snapshotId:observation.snapshotId};}}const n=inspected?.node,current=observation.nodes.find(x=>x.id===n?.id),valid=!!n&&!!current&&n.fingerprint===current.fingerprint&&!observation.uiError&&interactive()&&controlAllowed&&!appsBusy&&observation.controlAvailable;
    if(!current||current.fingerprint!==n?.fingerprint)q<HTMLElement>('.highlight-box').hidden=true;
    assign(q('.detail-name'),n?shortId(n,observation.nodes)+' · '+label(n,observation.nodes)+' · '+n.className.split('.').pop()+(valid?'':' · 操作暂停'):'请选择节点查看属性');
    assign(q('.detail-properties'),n?`${n.resourceId||n.description||n.className} · parent=${n.parentId||'root'}\nbounds=${JSON.stringify(n.bounds)} · clickable=${n.clickable} · editable=${n.editable} · checked=${n.checked}`:'');
    q<HTMLButtonElement>('.inspect-click').disabled=!valid||!n?.clickable;q<HTMLButtonElement>('.inspect-hold').disabled=!valid||!n?.longClickable;q<HTMLButtonElement>('.inspect-focus').disabled=!valid||!n?.editable;
    q<HTMLButtonElement>('.inspect-toggle').disabled=!valid||!n?.checkable||!n.clickable;assign(q('.inspect-toggle'),n?.checkable?(n.checked?'设为关闭':'设为开启'):'设置开关');q<HTMLButtonElement>('.locate').disabled=!n;q<HTMLButtonElement>('.properties').disabled=!n;
  }
  function update(state:Observation){if(!online)return;observation=state;if(touch?.active()&&(!interactive()||!state.controlAvailable||taskBusy))touch.cancel('手机控制状态已改变，手势已释放');assign(q('.device-model'),state.model||'Android');assign(q('.device-system'),state.system||state.android);assign(q('.phone-summary'),(state.keepAwake?'已设置保持亮屏':'保持亮屏未确认')+' · 5分钟无操作断连'+(state.summary?' · 电量 '+(state.summary.battery??'未知')+'%'+(state.summary.charging?' 充电':'')+' · 网络 '+(state.summary.network||'未知'):'')+(state.keepAwakeError?' · '+state.keepAwakeError:''));assign(q('.connection-state'),state.connected?'ADB 已连接':state.uiError&&state.controlAvailable?'UI 暂不可用':state.uiError?'连接异常':'未连接');assign(q('.foreground'),state.foregroundApp||'未知');assign(q('.android-focus'),state.focus?label(state.focus,state.nodes):'无可读输入框');assign(q('.display-size'),`${state.width} × ${state.height}`);
    assign(q('.transport-status'),state.videoError||state.uiError||(state.locked?'设备锁屏，请手动解锁':state.screenOn?'设备已亮屏':'设备息屏'));
    renderNodes();renderPhone();textState();route();fitPhone();
  }
  async function writeDraft(){
    const node=currentDraftTarget(observation,draftTarget);if(!node||!interactive()||textPending||!controlAllowed||taskBusy||appsBusy){textState('目标不可用，未发送；草稿保留');return;}
    const destination=label(node,observation.nodes),value=text.value,selected=draftTarget!,epoch=connectionEpoch;textPending=true;textState();
    try{const result=await perform('/api/node',{target:target(node),action:'setText',value});
      if(result.verification==='verified'&&draftTarget===selected)writtenDraft={target:selected,value,epoch,until:performance.now()+10000};
      textNotice=result.verification==='verified'?'已填写到 '+destination+'，原文已替换并验证':result.verification==='failed'?'已发送，但手机文字与草稿不同；请检查手机，不会自动重试':'已发送，结果未确认；请观察手机，不会自动重试';
    }catch(error){textNotice=String(error)+'；草稿保留，不会自动重试';}finally{textPending=false;textState();}
  }
  text.addEventListener('input',()=>{dirty=true;textState('草稿未发送；不会自动写入手机');});
  textTargetSelect.addEventListener('change',()=>chooseTextTarget(observation.nodes.find(n=>n.id===textTargetSelect.value)||null));
  q('.text-submit').addEventListener('click',()=>void writeDraft());
  q('.text-read').addEventListener('click',async()=>{
    if(textPending)return;if(dirty&&!await confirmAction('使用手机内容替换网页草稿？这不会修改手机。'))return;
    const node=currentDraftTarget(observation,draftTarget);if(!node||!interactive())return;const requestTarget=draftTarget;
    textPending=true;textState();try{const result=await api('/api/node/text',{target:target(node)});if(draftTarget!==requestTarget||!currentDraftTarget(observation,requestTarget))throw Error('目标已改变，未覆盖草稿');text.value=result.text;dirty=true;textNotice='已读取为网页草稿，未写入手机';}
    catch(error){textNotice=String(error)+'；草稿保留';}finally{textPending=false;textState();}
  });
  q('.clipboard-read').addEventListener('click',async()=>{if(dirty&&!await confirmAction('读取剪贴板将覆盖网页草稿，确认？'))return;try{const value=await api('/api/clipboard',{write:false});text.value=value.text;dirty=true;textState('剪贴板已读为草稿，未写入手机');}catch(error){log(String(error));}});
  q('.clipboard-write').addEventListener('click',async()=>{try{await api('/api/clipboard',{write:true,text:text.value});log('剪贴板写入请求已发送；未自动粘贴');}catch(error){log(String(error));}});
  q('.nodes-refresh').addEventListener('click',async()=>{try{update(await api('/api/refresh',{}));}catch(error){log(String(error));}});
  q('.timeline-copy').addEventListener('click',()=>void navigator.clipboard.writeText(q('.results').textContent||'').catch(()=>log('复制失败，请选择时间线文字复制')));
  qa('[data-filter]').forEach(b=>b.addEventListener('click',()=>{filter=b.dataset.filter!;renderNodes();}));q<HTMLInputElement>('.node-search').addEventListener('input',e=>{query=(e.target as HTMLInputElement).value;renderNodes();});
  for(const [selector,action]of [['.inspect-click','click'],['.inspect-hold','longPress'],['.inspect-focus','focus'],['.inspect-toggle','setChecked']])q(selector!).addEventListener('click',()=>{if(!inspected)return;void perform('/api/node',{target:{...target(inspected.node),snapshotId:inspected.snapshotId},action,value:action==='setChecked'?!inspected.node.checked:undefined}).catch(()=>{});});
  q('.properties').addEventListener('click',()=>{if(inspected)log(JSON.stringify(inspected.node,null,2));});
  q('.locate').addEventListener('click',()=>{if(!inspected)return;const [l,t,r,b]=inspected.node.bounds,box=q<HTMLElement>('.highlight-box');box.hidden=false;box.style.left=l/observation.width*100+'%';box.style.top=t/observation.height*100+'%';box.style.width=(r-l)/observation.width*100+'%';box.style.height=(b-t)/observation.height*100+'%';});
  async function releaseKeys(){if(control?.readyState===1)control.send(JSON.stringify({type:'keys-release'}));held.clear();}
  async function releaseInput(){touch?.cancel();await releaseKeys();}
  q('.capture').addEventListener('click',()=>{phone.focus({preventScroll:true});route();});q('.release').addEventListener('click',()=>{q<HTMLButtonElement>('.release').focus();void releaseKeys();route();});
  root.addEventListener('focusin',route);root.addEventListener('focusout',()=>setTimeout(()=>{if(document.activeElement!==phone)void releaseKeys();route();},0));
  addEventListener('blur',()=>{if(document.activeElement===phone)phone.blur();void releaseInput();route();});document.addEventListener('visibilitychange',()=>{if(document.hidden){if(document.activeElement===phone)phone.blur();void releaseInput();}route();});
  const held=new Map<string,{code:number;repeat:number}>();
  const keys=AndroidKeyCode as unknown as Record<string,number>;
  const browserKeys:Record<string,string>={Backspace:'Backspace',Escape:'Escape',Enter:'Enter',Tab:'Tab',Space:'Space',ArrowUp:'ArrowUp',ArrowDown:'ArrowDown',ArrowLeft:'ArrowLeft',ArrowRight:'ArrowRight',Home:'MoveHome',End:'MoveEnd',Delete:'ForwardDelete',ShiftLeft:'ShiftLeft',ShiftRight:'ShiftRight',ControlLeft:'ControlLeft',ControlRight:'ControlRight',AltLeft:'AltLeft',AltRight:'AltRight'};
  function metaKeys(e:KeyboardEvent){return (e.shiftKey?1:0)|(e.altKey?2:0)|(e.ctrlKey?4096:0)|(e.metaKey?65536:0);}
  function keyCode(e:KeyboardEvent){return keys[e.code]??keys[browserKeys[e.code]||''];}
  phone.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();text.focus();void releaseInput();return;}if(e.key==='Tab')return;if(e.isComposing||e.key==='Process'){log('中文请在网页草稿框填写，再点击“填写到手机”');return;}const code=keyCode(e);if(code===undefined||!interactive()||control?.readyState!==1||!observation.controlAvailable)return;e.preventDefault();if(!observation.focus&&((code>=29&&code<=54)||code===67))log('未确认文字焦点；当前仅发送原始硬件按键，文字效果未验证');if(!controlAllowed||appsBusy){log('设备忙，按键未发送');return;}const repeat=(held.get(e.code)?.repeat??-1)+1;held.set(e.code,{code,repeat});control.send(JSON.stringify({type:'key',request:crypto.randomUUID(),action:0,code,meta:metaKeys(e),repeat}));});
  phone.addEventListener('keyup',e=>{const previous=held.get(e.code);if(!previous)return;e.preventDefault();held.delete(e.code);if(control?.readyState===1)control.send(JSON.stringify({type:'key',request:crypto.randomUUID(),action:1,code:previous.code,meta:metaKeys(e),repeat:0}));});
  function showTouch(x:number,y:number){const mark=q<HTMLElement>('.touch-marker');mark.hidden=false;mark.style.left=x/meta.width*100+'%';mark.style.top=y/meta.height*100+'%';setTimeout(()=>mark.hidden=true,600);}
  touch=installTouch({element:phone,bufferElement:phonePane,bufferMargin:20,geometry:()=>{const r=canvas.getBoundingClientRect(),ratio=meta.width/meta.height,w=Math.min(r.width,r.height*ratio),h=w/ratio;return {width:meta.width,height:meta.height,left:r.left+(r.width-w)/2,top:r.top+(r.height-h)/2,displayWidth:w,displayHeight:h};},
    canStart:touchReady,
    canContinue:()=>interactive()&&control?.readyState===1&&observation.controlAvailable&&!taskBusy&&!appsBusy&&!!videoManager?.active(),
    unavailable:()=>{if(online&&powerKnown()&&(!observation.screenOn||observation.locked!==false)&&!waking)void wakePhone();else log((touchBlockedReason()||'触摸暂不可用')+'，触摸未发送');},
    send:message=>{if(control?.readyState!==1||(control.bufferedAmount||0)>131072)return false;control.send(JSON.stringify(message));return true;},
    changed:active=>{videoManager?.holdSelection(active);if(active)applications?.pause();else{if(online)applications?.resume();fitPhone();}renderPhone();inputAvailability();},point:showTouch,error:message=>{touchNotice=message;log(message);q('.mobile-status').setAttribute('title',message);renderPhone();setTimeout(()=>{touchNotice='';renderPhone();},5000);}});
  phone.addEventListener('click',event=>{if(online&&!interactive()&&!waking)void wakePhone();else if(interactive()&&controlAllowed&&!appsBusy&&event.detail===0&&!waking)void perform('/api/gesture',{kind:'tap',x:observation.width/2,y:observation.height/2}).catch(()=>{});});
  qa('[data-panel]').forEach(button=>button.addEventListener('click',()=>void perform('/api/panel',{kind:button.dataset.panel}).catch(()=>{})));
  q('.video-reconnect').addEventListener('click',()=>{if(!online)return;videoManager?.stop();connectVideo();log('重新建立视频，不改变设备控制连接');});
  q('.video-enlarge').addEventListener('click',()=>void enterImmersive());
  addEventListener('keydown',event=>{if(event.key==='Escape'&&phonePane.classList.contains('enlarged')){void exitImmersive();}});
  q('.screenshot-save').addEventListener('click',async()=>{try{const response=await fetch(viewUrl('/api/screenshot'));if(!response.ok)throw Error('截图失败');const value=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=value;link.download='phone-'+Date.now()+'.png';link.click();setTimeout(()=>URL.revokeObjectURL(value),5000);}catch(error){log(String(error));}});
  q('.wake').addEventListener('click',()=>void wakePhone());
  qa('[data-press]').forEach(b=>b.addEventListener('click',()=>void perform('/api/press',{key:b.dataset.press}).catch(()=>{})));
  qa('[data-gesture]').forEach(b=>b.addEventListener('click',()=>{const s=observation,w=s.width,h=s.height,name=b.dataset.gesture;let data:any;
    if(name==='doubleTap')data={kind:'doubleTap',x:w/2,y:h/2};else if(name==='zoomIn'||name==='zoomOut')data={kind:'pinch',x:w/2,y:h/2,startDistance:name==='zoomIn'?100:400,endDistance:name==='zoomIn'?400:100};
    else {const horizontal=name==='left'||name==='right',forward=name==='up'||name==='left';data={kind:'swipe',x1:horizontal?w*(forward?.75:.25):w/2,y1:horizontal?h/2:h*(forward?.75:.25),x2:horizontal?w*(forward?.25:.75):w/2,y2:horizontal?h/2:h*(forward?.25:.75)};}
    void perform('/api/gesture',data).catch(()=>{});
  }));
  const layouts:Record<string,string[][]>={letters:[['q','w','e','r','t','y','u','i','o','p'],['a','s','d','f','g','h','j','k','l'],['Shift','z','x','c','v','b','n','m','⌫'],['Ctrl','Alt','空格','Enter']],numbers:[['1','2','3'],['4','5','6'],['7','8','9'],['0','-','.','⌫','Enter']],functions:[['Esc','Tab','Enter','⌫'],['Home','↑','End'],['←','↓','→'],['Ctrl','Alt','Shift','Delete']]};
  const modifiers={shift:false,ctrl:false,alt:false};
  function keyboard(){q('.keys').replaceChildren();for(const line of layouts[keyMode]!){const row=document.createElement('div');row.className='key-row';for(const key of line){const b=document.createElement('button');b.type='button';b.textContent=key;b.setAttribute('aria-label','手机按键 '+key);b.className=key==='空格'?'space':key.length>1?'wide':'';if(['Shift','Ctrl','Alt'].includes(key))b.setAttribute('aria-pressed',String(modifiers[key.toLowerCase() as keyof typeof modifiers]));
    b.addEventListener('click',async()=>{if(['Shift','Ctrl','Alt'].includes(key)){const k=key.toLowerCase() as keyof typeof modifiers;modifiers[k]=!modifiers[k];keyboard();return;}const special:Record<string,string>={'⌫':'BACKSPACE','空格':'SPACE',Enter:'ENTER',Esc:'ESC',Tab:'TAB','↑':'UP','↓':'DOWN','←':'LEFT','→':'RIGHT',Delete:'DELETE',Home:'MOVE_HOME',End:'MOVE_END'};
      try{if(special[key])await perform('/api/press',{key:special[key],meta:(modifiers.shift?1:0)|(modifiers.ctrl?4096:0)|(modifiers.alt?2:0)});else{const code=/^[a-z]$/.test(key)?keys['Key'+key.toUpperCase()]:/^\d$/.test(key)?keys['Digit'+key]:keys[key==='-'?'Minus':key==='.'?'Period':'Comma'];if(code===undefined)throw new Error('未支持此键');if(control?.readyState!==1)throw new Error('控制通道未连接');control.send(JSON.stringify({type:'key',request:crypto.randomUUID(),action:0,code,meta:(modifiers.shift?1:0)|(modifiers.ctrl?4096:0)|(modifiers.alt?2:0),repeat:0}));control.send(JSON.stringify({type:'key',request:crypto.randomUUID(),action:1,code,meta:0,repeat:0}));}}catch(error){log(String(error));}
    });row.append(b);}q('.keys').append(row);}qa('[data-keys]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.keys===keyMode)));assign(q('.modifier-status'),'修饰键：'+(Object.entries(modifiers).filter(([,v])=>v).map(([k])=>k).join('+')||'关闭'));inputAvailability();}
  qa('[data-keys]').forEach(b=>b.addEventListener('click',()=>{keyMode=b.dataset.keys!;keyboard();}));
  function task(t:any){if(currentTask?.status==='running'&&currentTask.canStop&&t.id!==currentTask.id)return;if(!currentTask||t.startedAt>=currentTask.startedAt)currentTask=t;if(t.id!==currentTask.id)return;assign(q('.task-status'),t.status+' · '+t.steps+' 次调用');q<HTMLButtonElement>('.stop').disabled=t.status!=='running'||!t.canStop;q<HTMLButtonElement>('.run').disabled=t.status==='running';q<HTMLButtonElement>('.check-code').disabled=t.status==='running';assign(q('.result-status'),'任务 '+t.id.slice(0,8));
    const a=q<HTMLAnchorElement>('.task-link');a.href=viewUrl('/tasks/'+t.id);a.textContent='任务结果页';const content=document.createElement('pre');content.className='log-message';content.textContent=t.logs.join('\n')+(t.result!==undefined?'\n结果：'+JSON.stringify(t.result,null,2):'')+(t.error?'\n错误：'+t.error:'');q('.results').prepend(content);while(q('.results').children.length>100)q('.results').lastChild?.remove();
  }
  q('.run').addEventListener('click',async()=>{try{task(await api('/api/tasks',{code:editor.value,clickOptions:clickOptions()}));}catch(error){log(String(error));}});q('.check-code').addEventListener('click',async()=>{try{task(await api('/api/tasks',{code:editor.value,check:true,clickOptions:clickOptions()}));}catch(error){log(String(error));}});q('.stop').addEventListener('click',async()=>{if(currentTask)try{task(await api('/api/tasks/'+currentTask.id+'/stop',{}));}catch(error){log(String(error));}});
  function apiVisibility(open:boolean,focus=false){q<HTMLElement>('.api-panel').hidden=!open;q('.code-field').classList.toggle('help-open',open);q('.api-toggle').setAttribute('aria-expanded',String(open));if(focus)editor.focus();}
  for(const method of boot.apiMethods){const entry=document.createElement('section');entry.className='api-entry';const head=document.createElement('h3');head.className='api-signature';head.textContent=method.signature;entry.append(head);for(const value of [method.purpose,method.params,method.result]){const p=document.createElement('p');p.textContent=value;entry.append(p);}const example=document.createElement('pre');example.className='api-example';example.textContent=method.example;const note=document.createElement('p');note.className='dim';note.textContent=method.note;const button=document.createElement('button');button.type='button';button.className='api-insert';button.textContent='插入 '+method.name+' 示例';button.addEventListener('click',()=>{editor.setRangeText(method.example+'\n',editor.selectionStart,editor.selectionEnd,'end');apiVisibility(false,true);});entry.append(example,note,button);q('.api-details').append(entry);}
  q('.api-toggle').addEventListener('click',()=>apiVisibility(!!q<HTMLElement>('.api-panel').hidden));q('.api-panel').addEventListener('keydown',event=>{if((event as KeyboardEvent).key==='Escape'){event.preventDefault();event.stopPropagation();apiVisibility(false,true);}});
  function offlineReason(reason:string){if(reason==='IDLE_TIMEOUT')return '5分钟无操作，本页已断开；刷新或点击重新连接即可继续。';if(reason==='RECOVERY_TIMEOUT')return '恢复连接超时，请点击重新连接或刷新。';if(reason==='ORIGIN_REJECTED')return '连接来源验证失败，请刷新页面。';return reason==='PAGE_REPLACED'?'另一页面已连接，本页已离线；本页批量操作已停止。':reason==='SERVER_RESTART'?'服务已重启，请刷新页面重新连接。':['LOGIN_REQUIRED','LOGGED_OUT'].includes(reason)?'登录已失效，请刷新并重新登录。':'连接已断开，画面和状态已暂停。';}
  function renderPhone(){q<HTMLElement>('.mobile-reconnect').hidden=online||connecting;assign(q('.mobile-status'),recovering?'正在恢复连接':!online?'已离线':!powerKnown()?'手机状态未知':!observation.screenOn?'手机息屏':observation.locked!==false?'手机锁屏':touch?.active()?'触摸中':textPending?'正在处理文字':touchNotice?'手势已取消，详情见工具日志':touchReady()?'触摸就绪':'控制准备中');const known=powerKnown(),awake=observation.screenOn,unlocked=observation.locked===false;
    const title=recovering?'':!online?(connecting?'正在连接':'已离线'):waking?'正在唤醒并解锁':!known?'正在读取手机状态':!awake?'屏幕已关闭':!unlocked?'手机已锁屏':'';
    q<HTMLElement>('.screen-shield').hidden=!title;assign(q('.screen-title'),title);
    assign(q('.screen-help'),!online?'画面非实时。点击页面上方「重新连接」或刷新。':waking?'正在唤醒并请求解锁…':!known?'视频暂停，画面非实时。请稍候。':!awake||!unlocked?'视频已暂停，画面非实时。点击画面或下方「唤醒并解锁」。若未解锁，请在手机上完成。':'');
    assign(q('.device-status'),!known?'正在读取手机状态':!awake?'屏幕已关闭':!unlocked?'已锁屏':'已解锁');
    phone.setAttribute('aria-label',!online?'手机画面，当前页面已离线':!awake||!unlocked?'手机画面，点击唤醒并解锁':'手机画面，支持点击、长按和拖动，聚焦后键盘输入手机');
    q<HTMLButtonElement>('.wake').disabled=!online||waking||taskBusy||appsBusy;
    qa('[data-press],[data-gesture],[data-mode],[data-panel]').forEach(b=>(b as HTMLButtonElement).disabled=!interactive()||!controlAllowed||appsBusy);
    videoManager?.pauseChanged();renderVideoState();
  }
  async function wakePhone(){if(!online||waking||taskBusy||appsBusy)return;waking=true;renderPhone();try{const result=await perform('/api/wake',{});if(result){observation.screenOn=result.screenOn;observation.locked=result.locked;observation.powerCollectedAt=Date.now();}}
    catch(e){log(String(e));}finally{waking=false;renderPhone();textState();details();}}
  function goOffline(message:string){document.querySelector<HTMLDialogElement>('.action-confirmation')?.close('cancel');if(!online&&!connecting)return;clearRecoveryTimers();recovering=false;transportReady=false;if(message.includes('服务已重启')||message.includes('登录已失效'))needsRefresh=true;if(message.includes('登录已失效'))sessionStorage.setItem('android-console-login-reason','登录状态已失效，请重新登录。');online=false;connecting=false;connectionEpoch++;networkAbort.abort();if(currentTask)currentTask={...currentTask,canStop:false};held.clear();touch?.cancel(undefined,false);
    applications?.pause();const sockets=[eventsSocket,control];eventsSocket=null;control=null;for(const socket of sockets)try{socket?.close();}catch{}
    videoManager?.stop();canvas.pause();phone.dataset.videoConnection='closed';
    q<HTMLElement>('.workspace').inert=true;assign(q('.page-status'),'已离线');q('.page-status').setAttribute('data-state','offline');q<HTMLElement>('.page-reconnect').hidden=false;q<HTMLElement>('.connection-note').hidden=false;
    assign(q('.connection-note'),message+' 画面和状态停止更新；点击「重新连接」或刷新可接管手机。');assign(q('.transport-status'),'已离线');assign(q('.video-status'),'画面已暂停');textState();renderPhone();route();
  }
  async function connectPage(explicit=false){if(connecting)return;connecting=true;online=false;const epoch=++connectionEpoch;networkAbort=new AbortController();q<HTMLElement>('.workspace').inert=true;
    clearRecoveryTimers();transportReady=false;readySignal=false;
    assign(q('.page-status'),'连接中');q('.page-status').setAttribute('data-state','connecting');q<HTMLElement>('.page-reconnect').hidden=true;q<HTMLElement>('.connection-note').hidden=false;assign(q('.connection-note'),'正在连接；后打开的页面会接替之前的页面。');renderPhone();
    try{const r=await fetch(endpoint('/api/connection/connect'),{method:'POST',headers:{'Content-Type':'application/json','X-Console-CSRF':boot.csrf},body:JSON.stringify({pageId:boot.pageId,explicit}),signal:networkAbort.signal});const result=await r.json();if(epoch!==connectionEpoch)return;
      if(!r.ok){needsRefresh=['PAGE_EXPIRED','LOGIN_REQUIRED','CSRF_REJECTED'].includes(result.error?.code);if(result.error?.code==='LOGIN_REQUIRED')sessionStorage.setItem('android-console-login-reason','登录状态已失效，请重新登录。');throw new Error(result.error?.message||'连接失败');}
      sessionStorage.removeItem('android-console-login-reason');connectionId=result.connectionId;transportGeneration=result.generation||0;online=true;connecting=false;needsRefresh=false;frameRequiredAfter=performance.now();assign(q('.page-status'),'连接中');
      videoProvider=undefined;connectEvents();connectControl();void connectVideo();applications?.resume();update(observation);handshakeTimer=setTimeout(()=>beginRecovery(),8000);q<HTMLAnchorElement>('.task-link').href=viewUrl(currentTask?'/tasks/'+currentTask.id:'/observe');
    }catch(error){if(epoch===connectionEpoch)goOffline(error instanceof Error?error.message:String(error));}
  }
  q('.mobile-reconnect').addEventListener('click',()=>needsRefresh?location.reload():void connectPage(true));
  q('.page-reconnect').addEventListener('click',()=>needsRefresh?location.reload():void connectPage(true));
  function clearRecoveryTimers(){clearTimeout(recoveryTimer);clearTimeout(handshakeTimer);clearTimeout(recoveryDeadline);recoveryTimer=handshakeTimer=recoveryDeadline=undefined;}
  function closeControlSockets(){const old=[eventsSocket,control];eventsSocket=control=null;readySignal=false;for(const socket of old)try{socket?.close();}catch{}}
  function controlsReady(){if(!readySignal||control?.readyState!==1||eventsSocket?.readyState!==1)return;
    const restored=recovering;clearRecoveryTimers();recovering=false;connecting=false;online=true;transportReady=true;recoveryAttempt=0;lastControlMessage=lastEventsMessage=Date.now();
    q<HTMLElement>('.workspace').inert=false;assign(q('.page-status'),'在线');q('.page-status').setAttribute('data-state','online');q<HTMLElement>('.connection-note').hidden=true;
    if(restored){applications?.resume();connectVideo();log('原会话连接已恢复；旧操作未重放');}update(observation);inputAvailability();
  }
  function beginRecovery(){if(recovering||!online||!connectionId)return;clearRecoveryTimers();connectionEpoch++;recovering=true;connecting=true;online=false;transportReady=false;recoverySince=Date.now();recoveryAttempt=0;networkAbort.abort();
    document.querySelector<HTMLDialogElement>('.action-confirmation')?.close('cancel');if(currentTask)currentTask={...currentTask,canStop:false};touch?.cancel(undefined,true);void releaseKeys();applications?.pause();closeControlSockets();
    q<HTMLElement>('.workspace').inert=true;assign(q('.page-status'),'恢复连接');q('.page-status').setAttribute('data-state','recovering');q<HTMLElement>('.page-reconnect').hidden=true;q<HTMLElement>('.connection-note').hidden=false;
    assign(q('.connection-note'),'网络连接中断，正在恢复原会话；操作暂停，不会重放旧输入或接管其他页面。');assign(q('.video-status'),'控制连接恢复中');renderPhone();inputAvailability();
    recoveryDeadline=setTimeout(()=>goOffline(offlineReason('RECOVERY_TIMEOUT')),60000);scheduleRecovery(0);
  }
  function scheduleRecovery(delay?:number){if(!recovering||recoveryTimer!==undefined)return;clearTimeout(handshakeTimer);handshakeTimer=undefined;
    recoveryTimer=setTimeout(()=>{recoveryTimer=undefined;void resumeConnection();},delay??Math.min(5000,250*2**Math.min(recoveryAttempt,5)));
  }
  async function resumeConnection(){if(!recovering)return;if(Date.now()-recoverySince>=60000){goOffline(offlineReason('RECOVERY_TIMEOUT'));return;}
    const epoch=++connectionEpoch;recoveryAttempt++;closeControlSockets();networkAbort.abort();networkAbort=new AbortController();
    try{const response=await fetch(endpoint('/api/connection/resume'),{method:'POST',headers:{'Content-Type':'application/json','X-Console-CSRF':boot.csrf},body:JSON.stringify({pageId:boot.pageId,connectionId,videoAttemptId:videoManager?.active()?.id}),signal:AbortSignal.any([networkAbort.signal,AbortSignal.timeout(8000)])});const result=await response.json();if(!recovering||epoch!==connectionEpoch)return;
      if(!response.ok){if(response.status>=400&&response.status<500&&response.status!==429){needsRefresh=['LOGIN_REQUIRED','PAGE_EXPIRED','CSRF_REJECTED','ORIGIN_REJECTED'].includes(result.error?.code);goOffline(['LOGIN_REQUIRED','IDLE_TIMEOUT','RECOVERY_TIMEOUT'].includes(result.error?.code)?offlineReason(result.error.code):result.error?.message||'原会话已失效，自动恢复已停止');return;}throw Error('恢复请求暂未成功');}
      if(result.connectionId!==connectionId)throw Error('原会话身份不匹配');transportGeneration=result.generation;connectEvents();connectControl();handshakeTimer=setTimeout(()=>scheduleRecovery(),8000);
    }catch{if(recovering&&epoch===connectionEpoch)scheduleRecovery();}
  }
  function connectionMessage(data:any){if(data.type==='heartbeat')return true;if(data.type==='connection-ready'){if(data.generation===transportGeneration){readySignal=true;controlsReady();}return true;}if(data.type==='offline'){goOffline(offlineReason(data.reason));return true;}if(data.type==='recovering'){beginRecovery();return true;}return false;}
  function socketClosed(event:CloseEvent,epoch:number){if(epoch!==connectionEpoch||!online&&!recovering)return;
    if(['PAGE_REPLACED','LOGGED_OUT','LOGIN_REQUIRED','IDLE_TIMEOUT','RECOVERY_TIMEOUT','SERVER_RESTART','ORIGIN_REJECTED'].includes(event.reason)){goOffline(offlineReason(event.reason));return;}
    if(recovering)scheduleRecovery();else beginRecovery();
  }
  function connectControl(){const epoch=connectionEpoch,socket=new WebSocket(url('/ws/control'));control=socket;socket.onopen=()=>{if(epoch===connectionEpoch){lastControlMessage=Date.now();controlsReady();route();}};socket.onmessage=event=>{if(!online&&!recovering||epoch!==connectionEpoch)return;lastControlMessage=Date.now();const data=JSON.parse(event.data);if(connectionMessage(data))return;if(data.gesture){touch?.acknowledgement(data);return;}if(data.type==='error')log(data.message);else if(data.type==='ack'){ownsControl=true;route();if(data.request&&data.kind!=='move')log('事件 '+data.request.slice(0,8)+' · 已发送，未验证 · '+(data.backend||''));}};socket.onclose=event=>socketClosed(event,epoch);}
  setInterval(()=>{if(online){if(control?.readyState===1)control.send(JSON.stringify({type:'heartbeat'}));if(eventsSocket?.readyState===1)eventsSocket.send(JSON.stringify({type:'heartbeat'}));}},15000);
  function connectEvents(){const epoch=connectionEpoch,events=new WebSocket(url('/ws/events'));eventsSocket=events;events.onopen=()=>{if(epoch===connectionEpoch){lastEventsMessage=Date.now();controlsReady();}};events.onmessage=event=>{if(!online&&!recovering||epoch!==connectionEpoch)return;lastEventsMessage=Date.now();const data=JSON.parse(event.data);
    if(connectionMessage(data))return;
    if(data.type==='observation'){ownsControl=data.ownsControl;controlAllowed=data.controlAllowed;taskBusy=data.taskBusy;observation=data.state;update(data.state);}
    else if(data.type==='power'){observation.screenOn=data.screenOn;observation.locked=data.locked;observation.powerCollectedAt=data.powerCollectedAt;if(!interactive())void releaseInput();renderPhone();textState();details();}
    else if(data.type==='task')task(data.task);else if(data.type==='tasks')for(const t of data.tasks)task(t);
  };events.onclose=event=>socketClosed(event,epoch);}
  function checkControlHeartbeat(){if(online&&transportReady&&(Date.now()-lastControlMessage>45000||Date.now()-lastEventsMessage>45000))beginRecovery();}
  setInterval(checkControlHeartbeat,1000);addEventListener('offline',()=>beginRecovery());addEventListener('online',()=>{if(recovering){clearTimeout(recoveryTimer);recoveryTimer=undefined;scheduleRecovery(0);}});document.addEventListener('visibilitychange',()=>{if(!document.hidden){checkControlHeartbeat();if(recovering)scheduleRecovery(0);}});
  function ensureVideoManager(){
    if(videoManager)return;
    videoManager=createVideoManager({providers:videoProviders,container:phone,paused:videoPaused,
      assetVersion:boot.assetVersion,report:diagnostic=>{if(!online)return;
        void fetch(endpoint('/api/video/client-error'),{method:'POST',headers:{'Content-Type':'application/json','X-Console-CSRF':boot.csrf,
          'X-Console-Page':boot.pageId,'X-Console-Connection':connectionId,'X-Console-Generation':String(transportGeneration)},
          body:JSON.stringify(diagnostic),signal:AbortSignal.timeout(5000)}).catch(()=>{});},
      request:api,url:(path,id)=>{const value=new URL(url(path));value.searchParams.set('attemptId',id);return value.toString();},
      selected:slot=>{if(!slot)touch?.cancel('视频连接中断，手势已释放');renderVideoState();},frame:()=>renderVideoState(),changed:()=>renderVideoState()});
    canvas.style.visibility='hidden';wssCanvas.hidden=true;
  }
  function connectVideo(){ensureVideoManager();videoManager!.start(videoMode);}
  function renderVideoState(){const state=videoManager?.snapshot(),active=videoManager?.active(),current=state?.current;
    const now=performance.now(),paused=videoPaused();if(previousVideoPaused&&!paused)frameRequiredAfter=now;previousVideoPaused=paused;
    if(active&&typeof current?.lastFrameAt==='number')lastDisplayedFrameAt=current.lastFrameAt;
    const freshness=videoFreshness({online,connecting,recovering,pauseReason:videoPauseReason(),active:!!active,lastFrameAt:lastDisplayedFrameAt,requiredAfter:frameRequiredAfter,now});
    const rtt=active?.provider==='wss'?current?.media?.roundTripMs:current?.selectedPair?.roundTripMs;
    const latency=online&&active&&Number.isFinite(rtt)&&rtt>=0?`网络往返 ${Math.round(rtt)} ms`:'网络往返待测';
    assign(q('.video-freshness-status'),freshness.title+'；'+freshness.detail+'；'+latency);
    q('.video-freshness-status').setAttribute('data-state',freshness.state);
    const banner=q<HTMLElement>('.video-freshness-banner');banner.hidden=freshness.state==='current';banner.dataset.state=freshness.state;
    assign(q('.video-freshness-title'),freshness.title);assign(q('.video-freshness-detail'),freshness.detail);
    phone.dataset.videoFreshness=freshness.state;phone.dataset.lastFrameAgeMs=freshness.lastFrameAgeMs===null?'':String(Math.round(freshness.lastFrameAgeMs));
    if(!state||!online)return;
    videoProvider=active?.provider;const media=current?.media||{};const size=active?.handle?.size()||state.attempts.find(a=>a.width&&a.height);
    if(size?.width&&size?.height){meta.width=size.width;meta.height=size.height;touch?.validateGeometry();fitPhone();}
    Object.assign(phone.dataset,{videoProvider:videoProvider||'',videoConnection:current?.state||'connecting',iceMode:current?.mode||state.attempts[0]?.mode||'relay',
      mediaPath:videoProvider==='wss'?'wss':current?.path||'',framesRendered:String(current?.framesRendered||0),videoFramesDecoded:String(media.framesDecoded??media.decodedAndDrawnFrames??0),
      videoBytes:String(media.bytesReceived||0),videoPackets:String(media.packetsReceived||0),videoPaused:String(videoPaused())});
    q<HTMLElement>('.video-placeholder').hidden=!!active;
    assign(q('.video-status'),active?(videoPaused()?providerName(videoProvider)+' · 视频暂停，连接保留':providerName(videoProvider)+' 实时画面'):videoMode==='auto'?'正在并行连接视频':'正在连接 '+providerName(videoMode));
    qa('[data-video-mode]').forEach(i=>{const input=i as HTMLInputElement;input.checked=input.value===videoMode;input.disabled=!!touch?.active()||input.value!=='auto'&&!videoProviders.includes(input.value as VideoProvider);});
    networkInfo={state:current?.state||'connecting',provider:videoProvider||null,path:videoProvider==='wss'?'wss':current?.path||'',
      availableProviders:videoProviders,attempts:state.history,connections:state.attempts,retrying:state.retrying,
      ...current,mode:videoMode,freshness,media:{...media,paused:videoPaused(),pauseReason:videoPauseReason()},environment:{userAgent:navigator.userAgent,secureContext:window.isSecureContext,assetVersion:boot.assetVersion}};
  }
  qa('[data-video-mode]').forEach(i=>i.addEventListener('change',()=>{const input=i as HTMLInputElement;if(!input.checked)return;videoMode=input.value as VideoMode;localStorage.setItem('android-video-mode',videoMode);connectVideo();}));
  const network=root.querySelector<HTMLDetailsElement>('.video-network');
  q('.video-network-copy').addEventListener('click',async()=>{const button=q<HTMLButtonElement>('.video-network-copy'),status=q('.video-network-copy-status'),value=q('.video-network-data').textContent||'';if(!value||value==='等待连接信息'){assign(status,'暂无诊断可复制');return;}button.disabled=true;assign(status,'正在复制');
    try{try{await navigator.clipboard.writeText(value);}catch{const previous=document.activeElement,field=document.createElement('textarea');field.value=value;field.readOnly=true;field.style.cssText='position:fixed;left:-9999px;top:0';document.body.append(field);field.select();try{if(!document.execCommand('copy'))throw new Error('Clipboard unavailable');}finally{field.remove();if(previous instanceof HTMLElement)previous.focus({preventScroll:true});}}assign(status,'已复制');}
    catch{assign(status,'复制失败，请手动选择诊断文本');}finally{button.disabled=false;}});
  async function updateNetwork(){if(!network?.open||!online||networkLoading)return;const epoch=connectionEpoch;networkLoading=true;try{const server=await api('/api/webrtc/status');if(online&&epoch===connectionEpoch)q('.video-network-data').textContent=JSON.stringify({browser:{...(networkInfo as object||{}),state:phone.dataset.videoConnection,provider:videoProvider||null},server,input:{...touch?.snapshot(),ready:touchReady(),blockedReason:touchBlockedReason()}},null,2);}catch(error){if(online&&epoch===connectionEpoch)q('.video-network-data').textContent=String(error);}finally{networkLoading=false;}}
  network?.addEventListener('toggle',()=>void updateNetwork());
  setInterval(()=>{renderPhone();inputAvailability();if(online)void updateNetwork();},1000);
  let lastActivitySent=0;const activity=()=>{if(!online||Date.now()-lastActivitySent<3000)return;lastActivitySent=Date.now();void api('/api/activity',{}).catch(()=>{});};for(const name of ['pointerdown','keydown','input','wheel','change'])root.addEventListener(name,activity,{capture:true,passive:true});
  keyboard();void connectPage();
}
