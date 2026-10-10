import {confirmAction} from './confirmation.js';
import { AndroidKeyCode } from '@yume-chan/scrcpy';
import { label, nodeValue, shortId, shownNodes } from './presentation.js';
import type { AndroidNode, Observation, Target, TextBinding } from './types.js';
import { installApplications } from './applications-client.js';
import { normalizeBasePath,consolePath } from './paths.js';
import type {TurnProvider} from './turn-fallback.js';
import {createVideoManager} from './video-manager.js';
import type {VideoMode} from './video-race.js';
import {videoFreshness} from './video-freshness.js';
type VideoProvider=TurnProvider|'wss';
const basePath=normalizeBasePath(document.documentElement.dataset.consoleBase),endpoint=(path:string)=>consolePath(basePath,path);

const login=document.getElementById('login-form') as HTMLFormElement|null;
if(login){
  // A Strict cookie may be withheld on a cross-site navigation but is available here.
  void fetch(endpoint('/api/auth/status')).then(r=>r.json()).then(s=>{if(s.authenticated)location.reload();}).catch(()=>{});
  login.addEventListener('submit',async e=>{e.preventDefault();const values=new FormData(login),button=login.querySelector<HTMLButtonElement>('button')!,status=login.querySelector('output')!;button.disabled=true;status.textContent='正在验证…';try{const response=await fetch(endpoint('/api/login'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:values.get('password'),remember:values.get('remember')==='on',loginToken:values.get('loginToken')})});const result=await response.json();if(response.ok)location.reload();else status.textContent=result.error?.message||'登录失败';}catch{status.textContent='连接失败，请稍后重试';}finally{button.disabled=false;}});
}
else void initialize();

async function initialize() {
  const root=document.getElementById('android-observable')!,app=root.querySelector<HTMLElement>('.app')!;
  const q=<T extends Element=HTMLElement>(s:string)=>root.querySelector<T>(s)!,qa=(s:string)=>root.querySelectorAll<HTMLElement>(s);
  const right=document.createElement('div');right.className='right-shell';app.append(right);
  const workspace=q<HTMLElement>('.workspace'),phonePane=q('.phone-pane');app.prepend(phonePane);
  right.append(q('.topbar'),q('.routing'),q('.connection-note'),workspace);
  q('.routing').append(q('.phone-caption'),q('.video-modes'));
  const keyboardDetails=document.createElement('details');keyboardDetails.className='advanced-input';
  const summary=document.createElement('summary');summary.textContent='原始键盘与更多手势';keyboardDetails.append(summary);
  const keyboardPane=q('.keyboard-command');keyboardDetails.append(keyboardPane,q('.gesture-command'));q('.commands').style.position='relative';q('.commands').append(keyboardDetails);
  const process=q('[aria-label="检测到进程"]'),processDetails=document.createElement('details');processDetails.className='process-diagnostics';
  const processSummary=document.createElement('summary');processSummary.textContent='进程诊断（按需展开）';processDetails.append(processSummary,process);q('.applications-panel').append(processDetails);
  const closeZoom=document.createElement('button');closeZoom.className='close-enlarge';closeZoom.textContent='退出放大';closeZoom.addEventListener('click',()=>{phonePane.classList.remove('enlarged');fitPhone();});phonePane.append(closeZoom);
  const boot=JSON.parse(document.getElementById('console-bootstrap')!.textContent!);
  q('.logout')?.addEventListener('click',async()=>{if(!await confirmAction('退出登录会断开本会话并停止本会话任务，确认退出？'))return;const button=q<HTMLButtonElement>('.logout');button.disabled=true;try{const r=await fetch(endpoint('/api/logout'),{method:'POST',headers:{'Content-Type':'application/json','X-Console-CSRF':boot.csrf},body:'{}'});if(r.ok||r.status===401)location.reload();else{q<HTMLElement>('.connection-note').hidden=false;q('.connection-note').textContent='退出请求未完成，请刷新后重试';}}finally{button.disabled=false;}});
  let observation:Observation=boot.state,ownsControl=boot.ownsControl,controlAllowed=true,taskBusy=false,appsBusy=false,filter='compact',query='';
  let applications:ReturnType<typeof installApplications>|undefined;
  let online=false,connecting=false,connectionId='',connectionEpoch=0,networkAbort=new AbortController(),needsRefresh=false,waking=false,eventsSocket:WebSocket|null=null;
  let inspected:{node:AndroidNode;snapshotId:string}|null=null;
  let binding:TextBinding|null=null,auto=true,dirty=false,pending=0,revision=0,resend=false,baseText='',textNotice='',debounce:ReturnType<typeof setTimeout>|undefined,composing=false;
  let currentTask:any=boot.tasks[0]||null,keyMode='letters',mode='click',control:WebSocket|null=null;
  let meta={width:0,height:0,codec:0};
  let networkInfo:unknown=null,networkLoading=false;
  let videoProvider:VideoProvider|undefined;
  const providerName=(provider:VideoProvider|undefined)=>provider==='coturn'?'Home TURN':provider==='cloudflare'?'Cloudflare TURN':provider==='wss'?'WSS':'WebRTC';
  const videoPaused=()=>!observation.powerCollectedAt||!observation.screenOn||observation.locked!==false;
  const videoPauseReason=()=>!observation.powerCollectedAt?'power_unknown':!observation.screenOn?'screen_off':observation.locked!==false?'locked':null;
  let videoManager:ReturnType<typeof createVideoManager>|null=null;
  let lastDisplayedFrameAt:number|null=null,frameRequiredAfter=0,previousVideoPaused=true;
  const savedMode=localStorage.getItem('android-video-mode');
  let videoMode:VideoMode=savedMode&&['auto','coturn','cloudflare','wss'].includes(savedMode)?savedMode as VideoMode:'auto';
  const canvas=q<HTMLVideoElement>('.video-canvas'),phone=q<HTMLButtonElement>('.phone'),editor=q<HTMLTextAreaElement>('.code-input'),text=q<HTMLTextAreaElement>('.text-input');
  const proxy=q<HTMLTextAreaElement>('.screen-proxy');let bindingBusy=false,lastBindAttempt=0;
  const wssCanvas=q<HTMLCanvasElement>('.wss-canvas');
  const rows=new Map<string,{li:HTMLLIElement;button:HTMLButtonElement;num:HTMLElement;branch:HTMLElement;label:HTMLElement;value:HTMLElement;children:HTMLUListElement}>();
  q('.node-list').replaceChildren();
  const assign=(el:Element,value:string)=>{if(el.textContent!==value)el.textContent=value;};
  const target=(n:AndroidNode):Target=>({id:n.id,fingerprint:n.fingerprint,snapshotId:observation.snapshotId});
  const url=(path:string)=>{const u=new URL(endpoint(path),location.href);u.searchParams.set('page',boot.pageId);u.searchParams.set('connection',connectionId);return u.toString().replace(/^http/,'ws');};
  const viewUrl=(path:string)=>{const u=new URL(endpoint(path),location.href);u.searchParams.set('page',boot.pageId);u.searchParams.set('connection',connectionId);return u.pathname+u.search;};
  const interactive=()=>online&&!waking&&observation.screenOn&&observation.locked===false&&!!observation.powerCollectedAt;
  function fit(){app.style.transform='none';root.style.width='100%';root.style.height=innerHeight+'px';fitPhone();}
  addEventListener('resize',fit);
  function fitPhone(){const stage=q<HTMLElement>('.phone-stage');const ratio=meta.width&&meta.height?meta.width/meta.height:observation.width/observation.height;
    app.style.setProperty('--phone-column',Math.min(innerWidth*.46,(innerHeight-52)*ratio+16)+'px');
    const height=Math.min(stage.clientHeight-6,(stage.clientWidth-6)/ratio)*(phonePane.classList.contains('enlarged')?1.35:1);phone.style.height=height+'px';phone.style.width=height*ratio+'px';positionProxy();}
  function positionProxy(){const n=observation.focus,visible=bindValid()&&!!n&&!waking;proxy.hidden=!visible||!!meta.width&&Math.abs(meta.width/meta.height-observation.width/observation.height)>.04;
    if(!visible||!n)return;const stage=q('.phone-stage').getBoundingClientRect(),rect=phone.getBoundingClientRect(),[l,t,r,b]=n.bounds;
    proxy.style.left=rect.left-stage.left+l/observation.width*rect.width+'px';proxy.style.top=rect.top-stage.top+t/observation.height*rect.height+'px';
    proxy.style.width=(r-l)/observation.width*rect.width+'px';proxy.style.height=Math.max(28,(b-t)/observation.height*rect.height)+'px';proxy.setAttribute('aria-label','手机输入框：'+label(n,observation.nodes));
  }
  function mirror(value:string){if(text.value!==value)text.value=value;if(proxy.value!==value)proxy.value=value;}
  async function detectTarget(force=false){if(!online||!interactive()||bindingBusy||pending)return;if(bindValid()&&!force)return;
    if(dirty&&!force){auto=false;textState('目标改变，未发送草稿保留；重新检测前请核对目标');return;}
    if(!force&&(!observation.focus||Date.now()-lastBindAttempt<3000))return;
    const epoch=connectionEpoch,focus=observation.focus?.id;bindingBusy=true;lastBindAttempt=Date.now();
    try{const result=await api('/api/binding',{});if(!online||epoch!==connectionEpoch||result.binding.target.id!==observation.focus?.id||focus!==observation.focus?.id)return;
      binding=result.binding;baseText=result.text;if(!dirty){mirror(result.text);textNotice='目标已确认，可直接填写';}textState();positionProxy();if(document.activeElement===phone&&!pointer)proxy.focus({preventScroll:true});}
    catch(error){textNotice=String(error);textState();}finally{bindingBusy=false;}
  }
  fit();
  new ResizeObserver(fitPhone).observe(q('.phone-stage'));
  async function api(path:string,data?:unknown){if(!online)throw new Error('PAGE_OFFLINE: 本页已离线');const epoch=connectionEpoch;
    const response=await fetch(endpoint(path),{method:data===undefined?'GET':'POST',headers:{'X-Console-Page':boot.pageId,'X-Console-Connection':connectionId,...(data===undefined?{}:{'Content-Type':'application/json','X-Console-CSRF':boot.csrf})},body:data===undefined?undefined:JSON.stringify(data),signal:networkAbort.signal});
    const result=await response.json();if(!online||epoch!==connectionEpoch)throw new Error('PAGE_OFFLINE: 连接已更换');
    if(!response.ok){if(result.error?.code==='PAGE_OFFLINE')goOffline('另一页面已连接，本页已离线');throw new Error(result.error?.code+': '+result.error?.message);}return result;
  }
  function log(message:string){if(!online)return;const row=document.createElement('div');row.className='log-line';const prefix=document.createElement('span');prefix.className='log-time';prefix.textContent=new Date().toLocaleTimeString();const content=document.createElement('span');content.className='log-message';content.textContent=message;row.append(prefix,content);q('.results').prepend(row);q('.results').scrollTop=0;while(q('.results').children.length>100)q('.results').lastChild?.remove();}
  async function perform(path:string,data:any){if(path!=='/api/wake'&&(pending||(auto&&dirty))){await sendText();if(pending||dirty)throw Error('文字尚未写入确认，动作未发送');}try{const result=await api(path,{requestId:crypto.randomUUID(),...data});const names:Record<string,string>={'/api/node':data.action==='setText'?'填写文字':data.action==='focus'?'聚焦输入框':data.action==='click'?'点击':'节点动作','/api/press':'手机按键','/api/gesture':data.kind||'手势','/api/wake':'唤醒并解锁','/api/panel':data.kind==='notifications'?'展开通知栏':'展开控制中心','/api/apps/open':'打开应用','/api/android-tasks/switch':'切换任务','/api/navigation/back':'连续返回'};log((names[path]||path)+' · '+(data.key||data.packageName||data.target?.id||data.taskId||'')+' · '+(result.verification==='verified'?'效果已验证':result.verification==='failed'?'验证失败':result.verification==='inconclusive'?'无法确认效果':'已发送，未验证'));const detail=document.createElement('details'),title=document.createElement('summary'),pre=document.createElement('pre');title.textContent='技术详情';pre.textContent=JSON.stringify(result,null,2);detail.append(title,pre);q('.results').firstChild?.appendChild(detail);return result;}catch(error){log(String(error));throw error;}}
  applications=installApplications(root,{api,perform,canAct:()=>interactive()&&controlAllowed&&!appsBusy&&!pending&&!(auto&&dirty),online:()=>online,busyChanged:busy=>{appsBusy=busy;textState();details();if(!busy&&auto&&dirty&&bindValid())void sendText();}});
  function focusExplanation(reason:string|null|undefined){return ({WINDOW_CHANGED:'手机窗口已改变，等待重新检测',AMBIGUOUS_FOCUS:'多个输入目标，不能自动选择',NO_EDITABLE_FOCUS:'未发现可编辑焦点，请先选中手机输入框',PASSWORD_FIELD:'密码字段不支持镜像输入',FOCUS_CHANGED:'手机焦点已改变',TEXT_READ_UNSUPPORTED:'控件不支持文字回读'})[reason||'NO_EDITABLE_FOCUS']||'正在确认文字目标';}
  function bindValid(){return interactive()&&!!binding&&observation.focus?.id===binding.target.id&&observation.focusEpoch===binding.focusEpoch&&!observation.uiError;}
  function textState(message?:string){const valid=bindValid();q<HTMLInputElement>('.sync-toggle').disabled=!valid||(!controlAllowed||appsBusy);q<HTMLInputElement>('.sync-toggle').checked=auto;q<HTMLButtonElement>('.text-submit').disabled=!valid||auto||(!controlAllowed||appsBusy)||!!pending;q<HTMLButtonElement>('.rebind').disabled=!interactive()||taskBusy||appsBusy||!!pending;
    assign(q('.binding-target'),valid?'目标：'+label(observation.focus!,observation.nodes):binding?'目标已变化 · 草稿保留':'等待手机文字目标');
    if(message)textNotice=message;assign(q('.sync-status'),!online?'本页已离线，草稿已保留':!observation.screenOn?'点击手机画面或下方按钮唤醒并解锁':observation.locked!==false?'手机已锁屏，解锁后才能输入':!valid?(textNotice||focusExplanation(observation.focusReason)):appsBusy?'导航操作中，草稿保留':!controlAllowed?'暂不可写：脚本或其他会话控制设备':pending?'正在等待手机写入确认':textNotice||(auto?'直接编辑：网页修改写入手机，手机修改安全回读':'草稿模式：核对目标后提交'));positionProxy();inputAvailability();
  }
  function inputAvailability(){phone.disabled=!online||(interactive()&&(!!pending||(auto&&dirty)))||taskBusy||appsBusy;proxy.readOnly=taskBusy||appsBusy||!controlAllowed;text.readOnly=taskBusy||appsBusy||!controlAllowed||(auto&&!bindValid());const blocked=!interactive()||(!controlAllowed||appsBusy)||!observation.controlAvailable||!!pending||(auto&&dirty);q('.keys')?.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=blocked);qa('[data-press],[data-gesture],[data-mode],[data-panel]').forEach(b=>(b as HTMLButtonElement).disabled=blocked);q<HTMLButtonElement>('.run').disabled=taskBusy||!!pending||(auto&&dirty);q<HTMLButtonElement>('.check-code').disabled=taskBusy||!!pending||(auto&&dirty);details();route();}
  function route(){const active=document.activeElement,ready=interactive()&&!!control&&control.readyState===1&&observation.controlAvailable&&controlAllowed&&!appsBusy&&!pending&&!(auto&&dirty), captured=active===phone&&ready,writing=bindValid()&&auto&&(active===proxy||active===text);
    const focus=active===proxy?'手机文字输入':active===phone?'手机画面':active===text?'文本输入框':active===editor?'JS 编辑框':active===q('.node-search')?'元素搜索框':'网页';
    q('.routing').classList.toggle('captured',captured);assign(q('.focus-target'),focus);assign(q('.key-target'),writing?'手机文字':captured?'手机按键':'网页');assign(q('.keyboard-backend'),observation.keyboardBackend==='uhid'?'原始键盘：UHID':'原始键盘：兼容按键；推荐文字直达');assign(q('.capture-status'),!online?'已离线':writing?'文字直达手机 · 写入后验证':captured?'键盘输入手机 · Esc 退出':active===phone?'手机暂不可输入':'键盘留在网页');
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
  function inspect(id:string){const source=observation,n=source.nodes.find(n=>n.id===id);if(!n)return;inspected={node:structuredClone(n),snapshotId:source.snapshotId};rows.forEach((row,key)=>row.button.classList.toggle('is-inspected',key===id));details();}
  function details(){if(inspected){const latest=observation.nodes.find(n=>n.id===inspected!.node.id);if(latest&&(latest.resourceId?latest.resourceId===inspected.node.resourceId&&latest.package===inspected.node.package:latest.className===inspected.node.className)&&JSON.stringify(latest.bounds)===JSON.stringify(inspected.node.bounds)&&(latest.editable||latest.text===inspected.node.text)){inspected={node:structuredClone(latest),snapshotId:observation.snapshotId};}}const n=inspected?.node,current=observation.nodes.find(x=>x.id===n?.id),valid=!!n&&!!current&&n.fingerprint===current.fingerprint&&!observation.uiError&&interactive()&&controlAllowed&&!appsBusy&&observation.controlAvailable&&!pending&&!(auto&&dirty);
    if(!current||current.fingerprint!==n?.fingerprint)q<HTMLElement>('.highlight-box').hidden=true;
    assign(q('.detail-name'),n?shortId(n,observation.nodes)+' · '+label(n,observation.nodes)+' · '+n.className.split('.').pop()+(valid?'':' · 操作暂停'):'请选择节点查看属性');
    assign(q('.detail-properties'),n?`${n.resourceId||n.description||n.className} · parent=${n.parentId||'root'}\nbounds=${JSON.stringify(n.bounds)} · clickable=${n.clickable} · editable=${n.editable} · checked=${n.checked}`:'');
    q<HTMLButtonElement>('.inspect-click').disabled=!valid||!n?.clickable;q<HTMLButtonElement>('.inspect-hold').disabled=!valid||!n?.longClickable;q<HTMLButtonElement>('.inspect-focus').disabled=!valid||!n?.editable;
    q<HTMLButtonElement>('.inspect-toggle').disabled=!valid||!n?.checkable||!n.clickable;assign(q('.inspect-toggle'),n?.checkable?(n.checked?'设为关闭':'设为开启'):'设置开关');q<HTMLButtonElement>('.locate').disabled=!n;q<HTMLButtonElement>('.properties').disabled=!n;
  }
  function update(state:Observation){if(!online)return;observation=state;if(binding&&(state.focus?.id!==binding.target.id||state.focusEpoch!==binding.focusEpoch)){binding=null;textNotice=dirty?'目标改变，未发送草稿已保留':focusExplanation(state.focusReason);}assign(q('.device-model'),state.model||'Android');assign(q('.device-system'),state.system||state.android);assign(q('.phone-summary'),(state.keepAwake?'连接保持亮屏':'保持亮屏未确认')+' · 5分钟无操作断连'+(state.summary?' · 电量 '+(state.summary.battery??'未知')+'%'+(state.summary.charging?' 充电':'')+' · 网络 '+(state.summary.network||'未知'):'')+(state.keepAwakeError?' · '+state.keepAwakeError:''));assign(q('.connection-state'),state.connected?'ADB 已连接':state.uiError&&state.controlAvailable?'UI 暂不可用':state.uiError?'连接异常':'未连接');assign(q('.foreground'),state.foregroundApp||'未知');assign(q('.android-focus'),state.focus?label(state.focus,state.nodes):'无可读输入框');assign(q('.display-size'),`${state.width} × ${state.height}`);
    assign(q('.transport-status'),state.videoError||state.uiError||(state.locked?'设备锁屏，请手动解锁':state.screenOn?'设备已亮屏':'设备息屏'));if(bindValid()&&auto&&!dirty&&!pending&&!composing){mirror(state.focus?.text||'');baseText=text.value;}
    renderNodes();renderPhone();textState();route();fitPhone();void detectTarget();
  }
  async function sendText(){clearTimeout(debounce);if(appsBusy){textState('导航操作中，草稿等待同步');return;}if(pending){resend=true;return;}const value=text.value,version=revision,current=binding;if(!current||!bindValid()){textState('目标失效，草稿保留，未发送');return;}pending=1;resend=false;textState();
    try{const result=await api('/api/text',{binding:current,text:value,expectedText:baseText});if(binding!==current||observation.focus?.id!==current.target.id||observation.focusEpoch!==current.focusEpoch)return;baseText=result.text;if(version===revision){dirty=false;mirror(result.text);}textNotice=dirty?'新的草稿尚未发送':'文字写入已确认';}
    catch(error){auto=false;resend=false;textNotice=String(error)+'；草稿保留';log(String(error));}
    finally{pending=0;const again=auto&&dirty&&resend&&bindValid();resend=false;textState();if(again)void sendText();}
  }
  const edited=(source:HTMLTextAreaElement)=>{if(source===proxy)text.value=proxy.value;else proxy.value=text.value;revision++;dirty=true;if(auto&&!composing){clearTimeout(debounce);debounce=setTimeout(sendText,180);textState('新文字等待同步');}else textState('网页草稿未发送');};for(const source of [text,proxy]){source.addEventListener('input',()=>edited(source));source.addEventListener('compositionstart',()=>composing=true);source.addEventListener('compositionend',()=>{composing=false;if(auto){clearTimeout(debounce);debounce=setTimeout(sendText,180);}});}
  let submittingText=false;
  proxy.addEventListener('keydown',async event=>{
    if(!['Enter','Tab'].includes(event.key)||event.key==='Enter'&&event.shiftKey||event.isComposing)return;
    event.preventDefault();if(submittingText||!binding)return;submittingText=true;const current=binding;
    try{const deadline=Date.now()+20000;while(pending&&online&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
      if(!online||pending)throw Error('文字仍未确认，提交按键未发送');if(dirty)await sendText();
      if(dirty||pending||binding!==current||!bindValid())throw Error('目标或文字未确认，提交按键未发送');
      await perform('/api/press',{key:event.key==='Enter'?'ENTER':'TAB',meta:event.shiftKey?1:0,binding:current});
    }catch(error){log(String(error));}finally{submittingText=false;}
  });
  text.addEventListener('compositionstart',()=>composing=true);text.addEventListener('compositionend',()=>{composing=false;if(auto){clearTimeout(debounce);debounce=setTimeout(sendText,180);}});
  q<HTMLInputElement>('.sync-toggle').addEventListener('change',e=>{auto=(e.target as HTMLInputElement).checked;textNotice='';if(auto&&dirty)void sendText();textState();});q('.text-submit').addEventListener('click',()=>void sendText());
  q('.rebind').addEventListener('click',async()=>{if(dirty&&!await confirmAction('保留草稿并改用当前手机输入目标？草稿不会自动发送。'))return;binding=null;void detectTarget(true);});
  q('.text-read').addEventListener('click',async()=>{if(dirty&&!await confirmAction('使用手机文字覆盖未发送草稿？'))return;dirty=false;binding=null;await detectTarget(true);});
  q('.text-to-selected').addEventListener('click',async()=>{if(!inspected)return;try{await perform('/api/node',{target:target(inspected.node),action:'setText',value:text.value});dirty=false;await detectTarget(true);}catch{}});
  q('.clipboard-read').addEventListener('click',async()=>{if(dirty&&!await confirmAction('读取剪贴板将覆盖网页草稿，确认？'))return;try{const value=await api('/api/clipboard',{write:false});mirror(value.text);revision++;dirty=true;auto=false;textState('手机剪贴板已读为草稿，尚未写入输入框');}catch(error){log(String(error));}});
  q('.clipboard-write').addEventListener('click',async()=>{try{await api('/api/clipboard',{write:true,text:text.value});log('剪贴板写入请求已发送；未自动粘贴');}catch(error){log(String(error));}});
  q('.nodes-refresh').addEventListener('click',async()=>{try{update(await api('/api/refresh',{}));}catch(error){log(String(error));}});
  q('.timeline-copy').addEventListener('click',()=>void navigator.clipboard.writeText(q('.results').textContent||'').catch(()=>log('复制失败，请选择时间线文字复制')));
  qa('[data-filter]').forEach(b=>b.addEventListener('click',()=>{filter=b.dataset.filter!;renderNodes();}));q<HTMLInputElement>('.node-search').addEventListener('input',e=>{query=(e.target as HTMLInputElement).value;renderNodes();});
  for(const [selector,action]of [['.inspect-click','click'],['.inspect-hold','longPress'],['.inspect-focus','focus'],['.inspect-toggle','setChecked']])q(selector!).addEventListener('click',()=>{if(!inspected)return;void perform('/api/node',{target:{...target(inspected.node),snapshotId:inspected.snapshotId},action,value:action==='setChecked'?!inspected.node.checked:undefined}).then(()=>{if(action==='focus')void detectTarget(true);}).catch(()=>{});});
  q('.properties').addEventListener('click',()=>{if(inspected)log(JSON.stringify(inspected.node,null,2));});
  q('.locate').addEventListener('click',()=>{if(!inspected)return;const [l,t,r,b]=inspected.node.bounds,box=q<HTMLElement>('.highlight-box');box.hidden=false;box.style.left=l/observation.width*100+'%';box.style.top=t/observation.height*100+'%';box.style.width=(r-l)/observation.width*100+'%';box.style.height=(b-t)/observation.height*100+'%';});
  async function releaseInput(){cancelPointer();if(control?.readyState===1)control.send(JSON.stringify({type:'release'}));held.clear();}
  q('.capture').addEventListener('click',()=>{(bindValid()?proxy:phone).focus();route();});q('.release').addEventListener('click',()=>{q<HTMLButtonElement>('.release').focus();void releaseInput();route();});
  root.addEventListener('focusin',route);root.addEventListener('focusout',()=>setTimeout(()=>{if(document.activeElement!==phone)void releaseInput();route();},0));
  addEventListener('blur',()=>{if(document.activeElement===phone)phone.blur();void releaseInput();route();});document.addEventListener('visibilitychange',()=>{if(document.hidden){if(document.activeElement===phone)phone.blur();void releaseInput();}route();});
  const held=new Map<string,{code:number;repeat:number}>();
  const keys=AndroidKeyCode as unknown as Record<string,number>;
  const browserKeys:Record<string,string>={Backspace:'Backspace',Escape:'Escape',Enter:'Enter',Tab:'Tab',Space:'Space',ArrowUp:'ArrowUp',ArrowDown:'ArrowDown',ArrowLeft:'ArrowLeft',ArrowRight:'ArrowRight',Home:'MoveHome',End:'MoveEnd',Delete:'ForwardDelete',ShiftLeft:'ShiftLeft',ShiftRight:'ShiftRight',ControlLeft:'ControlLeft',ControlRight:'ControlRight',AltLeft:'AltLeft',AltRight:'AltRight'};
  function metaKeys(e:KeyboardEvent){return (e.shiftKey?1:0)|(e.altKey?2:0)|(e.ctrlKey?4096:0)|(e.metaKey?65536:0);}
  function keyCode(e:KeyboardEvent){return keys[e.code]??keys[browserKeys[e.code]||''];}
  phone.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();q<HTMLButtonElement>('.release').focus();void releaseInput();return;}if(e.key==='Tab')return;if(e.isComposing||e.key==='Process'){log('中文请使用文字同步输入框');return;}const code=keyCode(e);if(code===undefined||!interactive()||control?.readyState!==1||!observation.controlAvailable)return;e.preventDefault();if(!observation.focus&&((code>=29&&code<=54)||code===67))log('未确认文字焦点；当前仅发送原始硬件按键，文字效果未验证');if(pending||(auto&&dirty)||(!controlAllowed||appsBusy)){log('文本待确认或设备忙，按键未发送');return;}const repeat=(held.get(e.code)?.repeat??-1)+1;held.set(e.code,{code,repeat});control.send(JSON.stringify({type:'key',request:crypto.randomUUID(),action:0,code,meta:metaKeys(e),repeat}));});
  phone.addEventListener('keyup',e=>{const previous=held.get(e.code);if(!previous)return;e.preventDefault();held.delete(e.code);if(control?.readyState===1)control.send(JSON.stringify({type:'key',request:crypto.randomUUID(),action:1,code:previous.code,meta:metaKeys(e),repeat:0}));});
  let pointer:{id:number;browserId:number;x:number;y:number;lastX:number;lastY:number;time:number;width:number;height:number;upSeen:boolean}|null=null;
  let movePending:PointerEvent|null=null,moveFrame=0,holdTimer:ReturnType<typeof setTimeout>|undefined;
  const point=(event:PointerEvent)=>{const r=canvas.getBoundingClientRect(),width=pointer?.width??meta.width,height=pointer?.height??meta.height;return {x:Math.max(0,Math.min(width-1,(event.clientX-r.left)/r.width*width)),y:Math.max(0,Math.min(height-1,(event.clientY-r.top)/r.height*height))};};
  function showTouch(x:number,y:number){const mark=q<HTMLElement>('.touch-marker');mark.hidden=false;mark.style.left=x/meta.width*100+'%';mark.style.top=y/meta.height*100+'%';setTimeout(()=>mark.hidden=true,600);}
  function rawTouch(action:number,x:number,y:number){if(!pointer||control?.readyState!==1)return;control.send(JSON.stringify({type:'touch',request:crypto.randomUUID(),kind:action===2?'move':'touch',action,id:pointer.id,x,y,width:pointer.width,height:pointer.height}));}
  function clearMove(){cancelAnimationFrame(moveFrame);moveFrame=0;movePending=null;}
  function cancelPointer(send=true){clearMove();clearTimeout(holdTimer);const old=pointer;if(!old)return;if(send)rawTouch(1,old.lastX,old.lastY);pointer=null;try{if(phone.hasPointerCapture(old.browserId))phone.releasePointerCapture(old.browserId);}catch{}}
  phone.addEventListener('dragstart',event=>event.preventDefault());
  phone.addEventListener('pointerdown',event=>{if(pointer||event.button!==0||!online||waking)return;if(!interactive()){event.preventDefault();if(!waking)void wakePhone();return;}if(control?.readyState!==1||!meta.width||!observation.controlAvailable||pending||(auto&&dirty)||(!controlAllowed||appsBusy))return;event.preventDefault();const p=point(event);pointer={id:10,browserId:event.pointerId,x:p.x,y:p.y,lastX:p.x,lastY:p.y,time:Date.now(),width:meta.width,height:meta.height,upSeen:false};phone.focus();try{phone.setPointerCapture(event.pointerId);}catch{}showTouch(p.x,p.y);rawTouch(0,p.x,p.y);});
  // Document listeners also finish drags when pointer capture is unavailable.
  document.addEventListener('pointermove',event=>{if(!pointer||pointer.upSeen||event.pointerId!==pointer.browserId)return;movePending=event;if(moveFrame)return;moveFrame=requestAnimationFrame(()=>{moveFrame=0;if(!movePending||!pointer)return;const p=point(movePending);movePending=null;pointer.lastX=p.x;pointer.lastY=p.y;rawTouch(2,p.x,p.y);});},true);
  document.addEventListener('pointerup',event=>{if(!pointer||pointer.upSeen||event.pointerId!==pointer.browserId)return;const p=point(event),old=pointer;clearMove();old.upSeen=true;old.lastX=p.x;old.lastY=p.y;
    // Flush a quick drag before UP even if every MOVE was coalesced into a pending frame.
    if(Math.hypot(p.x-old.x,p.y-old.y)>=15)rawTouch(2,p.x,p.y);
    if(mode==='hold'&&Math.hypot(p.x-old.x,p.y-old.y)<15&&Date.now()-old.time<700){holdTimer=setTimeout(()=>{if(pointer===old)cancelPointer();},700-(Date.now()-old.time));}else cancelPointer();},true);
  document.addEventListener('pointercancel',event=>{if(pointer?.browserId===event.pointerId)void releaseInput();},true);
  phone.addEventListener('lostpointercapture',event=>{if(pointer?.browserId===event.pointerId&&!pointer.upSeen)cancelPointer();});
  phone.addEventListener('click',event=>{if(online&&!interactive()&&!waking)void wakePhone();else if(interactive()&&controlAllowed&&!appsBusy&&!pending&&event.detail===0&&!waking)void perform('/api/gesture',{kind:'tap',x:observation.width/2,y:observation.height/2}).catch(()=>{});});
  qa('[data-panel]').forEach(button=>button.addEventListener('click',()=>void perform('/api/panel',{kind:button.dataset.panel}).catch(()=>{})));
  q('.video-reconnect').addEventListener('click',()=>{if(!online)return;videoManager?.stop();connectVideo();log('重新建立视频，不改变设备控制连接');});
  q('.video-enlarge').addEventListener('click',()=>{phonePane.classList.toggle('enlarged');q('.video-enlarge').textContent=phonePane.classList.contains('enlarged')?'退出放大':'放大查看';fitPhone();});
  addEventListener('keydown',event=>{if(event.key==='Escape'&&phonePane.classList.contains('enlarged')){phonePane.classList.remove('enlarged');fitPhone();}});
  q('.screenshot-save').addEventListener('click',async()=>{try{const response=await fetch(viewUrl('/api/screenshot'));if(!response.ok)throw Error('截图失败');const value=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=value;link.download='phone-'+Date.now()+'.png';link.click();setTimeout(()=>URL.revokeObjectURL(value),5000);}catch(error){log(String(error));}});
  q('.wake').addEventListener('click',()=>void wakePhone());
  qa('[data-mode]').forEach(b=>b.addEventListener('click',()=>{mode=b.dataset.mode!;qa('[data-mode]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));}));
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
  q('.run').addEventListener('click',async()=>{try{task(await api('/api/tasks',{code:editor.value}));}catch(error){log(String(error));}});q('.check-code').addEventListener('click',async()=>{try{task(await api('/api/tasks',{code:editor.value,check:true}));}catch(error){log(String(error));}});q('.stop').addEventListener('click',async()=>{if(currentTask)try{task(await api('/api/tasks/'+currentTask.id+'/stop',{}));}catch(error){log(String(error));}});
  function apiVisibility(open:boolean,focus=false){q<HTMLElement>('.api-panel').hidden=!open;q('.code-field').classList.toggle('help-open',open);q('.api-toggle').setAttribute('aria-expanded',String(open));if(focus)editor.focus();}
  for(const method of boot.apiMethods){const entry=document.createElement('section');entry.className='api-entry';const head=document.createElement('h3');head.className='api-signature';head.textContent=method.signature;entry.append(head);for(const value of [method.purpose,method.params,method.result]){const p=document.createElement('p');p.textContent=value;entry.append(p);}const example=document.createElement('pre');example.className='api-example';example.textContent=method.example;const note=document.createElement('p');note.className='dim';note.textContent=method.note;const button=document.createElement('button');button.type='button';button.className='api-insert';button.textContent='插入 '+method.name+' 示例';button.addEventListener('click',()=>{editor.setRangeText(method.example+'\n',editor.selectionStart,editor.selectionEnd,'end');apiVisibility(false,true);});entry.append(example,note,button);q('.api-details').append(entry);}
  q('.api-toggle').addEventListener('click',()=>apiVisibility(!!q<HTMLElement>('.api-panel').hidden));q('.api-panel').addEventListener('keydown',event=>{if((event as KeyboardEvent).key==='Escape'){event.preventDefault();event.stopPropagation();apiVisibility(false,true);}});
  function offlineReason(reason:string){if(reason==='IDLE_TIMEOUT')return '5分钟无操作，本页已断开；刷新或点击重新连接即可继续。';return reason==='PAGE_REPLACED'?'另一页面已连接，本页已离线；本页批量操作已停止。':reason==='SERVER_RESTART'?'服务已重启，请刷新页面重新连接。':['LOGIN_REQUIRED','LOGGED_OUT'].includes(reason)?'登录已失效，请刷新并重新登录。':'连接已断开，画面和状态已暂停。';}
  function renderPhone(){const known=!!observation.powerCollectedAt,awake=observation.screenOn,unlocked=observation.locked===false;
    const title=!online?(connecting?'正在连接':'已离线'):waking?'正在唤醒并解锁':!known?'正在读取手机状态':!awake?'屏幕已关闭':!unlocked?'手机已锁屏':'';
    q<HTMLElement>('.screen-shield').hidden=!title;assign(q('.screen-title'),title);
    assign(q('.screen-help'),!online?'画面非实时。点击页面上方「重新连接」或刷新。':waking?'正在唤醒并请求解锁…':!known?'视频暂停，画面非实时。请稍候。':!awake||!unlocked?'视频已暂停，画面非实时。点击画面或下方「唤醒并解锁」。若未解锁，请在手机上完成。':'');
    assign(q('.device-status'),!known?'正在读取手机状态':!awake?'屏幕已关闭':!unlocked?'已锁屏':'已解锁');
    phone.setAttribute('aria-label',!online?'手机画面，当前页面已离线':!awake||!unlocked?'手机画面，点击唤醒并解锁':'手机画面，支持点击、长按和拖动，聚焦后键盘输入手机');
    q<HTMLButtonElement>('.wake').disabled=!online||waking||taskBusy||appsBusy;
    qa('[data-press],[data-gesture],[data-mode],[data-panel]').forEach(b=>(b as HTMLButtonElement).disabled=!interactive()||!controlAllowed||appsBusy||!!pending);
    videoManager?.pauseChanged();renderVideoState();
  }
  async function wakePhone(){if(!online||waking||taskBusy||appsBusy)return;waking=true;renderPhone();try{const result=await perform('/api/wake',{});if(result){observation.screenOn=result.screenOn;observation.locked=result.locked;observation.powerCollectedAt=Date.now();}}
    catch(e){log(String(e));}finally{waking=false;renderPhone();textState();details();}}
  function goOffline(message:string){document.querySelector<HTMLDialogElement>('.action-confirmation')?.close('cancel');if(!online&&!connecting)return;if(message.includes('服务已重启')||message.includes('登录已失效'))needsRefresh=true;online=false;connecting=false;connectionEpoch++;networkAbort.abort();auto=false;binding=null;if(currentTask)currentTask={...currentTask,canStop:false};clearTimeout(debounce);held.clear();cancelPointer(false);
    applications?.pause();const sockets=[eventsSocket,control];eventsSocket=null;control=null;for(const socket of sockets)try{socket?.close();}catch{}
    videoManager?.stop();canvas.pause();phone.dataset.videoConnection='closed';
    q<HTMLElement>('.workspace').inert=true;assign(q('.page-status'),'已离线');q('.page-status').setAttribute('data-state','offline');q<HTMLElement>('.page-reconnect').hidden=false;q<HTMLElement>('.connection-note').hidden=false;
    assign(q('.connection-note'),message+' 画面和状态停止更新；点击「重新连接」或刷新可接管手机。');assign(q('.transport-status'),'已离线');assign(q('.video-status'),'画面已暂停');textState();renderPhone();route();
  }
  async function connectPage(explicit=false){if(connecting)return;connecting=true;online=false;const epoch=++connectionEpoch;networkAbort=new AbortController();q<HTMLElement>('.workspace').inert=true;
    assign(q('.page-status'),'连接中');q('.page-status').setAttribute('data-state','connecting');q<HTMLElement>('.page-reconnect').hidden=true;q<HTMLElement>('.connection-note').hidden=false;assign(q('.connection-note'),'正在连接；后打开的页面会接替之前的页面。');renderPhone();
    try{const r=await fetch(endpoint('/api/connection/connect'),{method:'POST',headers:{'Content-Type':'application/json','X-Console-CSRF':boot.csrf},body:JSON.stringify({pageId:boot.pageId,explicit}),signal:networkAbort.signal});const result=await r.json();if(epoch!==connectionEpoch)return;
      if(!r.ok){needsRefresh=['PAGE_EXPIRED','LOGIN_REQUIRED','CSRF_REJECTED'].includes(result.error?.code);throw new Error(result.error?.message||'连接失败');}
      connectionId=result.connectionId;online=true;connecting=false;needsRefresh=false;frameRequiredAfter=performance.now();q<HTMLElement>('.workspace').inert=false;assign(q('.page-status'),'在线');q('.page-status').setAttribute('data-state','online');q<HTMLElement>('.connection-note').hidden=true;
      videoProvider=undefined;connectEvents();connectControl();void connectVideo();applications?.resume();update(observation);q<HTMLAnchorElement>('.task-link').href=viewUrl(currentTask?'/tasks/'+currentTask.id:'/observe');
    }catch(error){if(epoch===connectionEpoch)goOffline(error instanceof Error?error.message:String(error));}
  }
  q('.page-reconnect').addEventListener('click',()=>needsRefresh?location.reload():void connectPage(true));
  function connectControl(){const epoch=connectionEpoch,socket=new WebSocket(url('/ws/control'));control=socket;socket.onopen=()=>{if(epoch===connectionEpoch)route();};socket.onmessage=event=>{if(!online||epoch!==connectionEpoch)return;const data=JSON.parse(event.data);if(data.type==='offline'){goOffline(offlineReason(data.reason));return;}if(data.type==='error')log(data.message);else if(data.type==='ack'){ownsControl=true;route();if(data.request&&data.kind!=='move')log('事件 '+data.request.slice(0,8)+' · 已发送，未验证 · '+(data.backend||''));}};socket.onclose=event=>{if(online&&epoch===connectionEpoch)goOffline(offlineReason(event.reason));};}
  setInterval(()=>{if(online){if(control?.readyState===1)control.send(JSON.stringify({type:'heartbeat'}));if(eventsSocket?.readyState===1)eventsSocket.send(JSON.stringify({type:'heartbeat'}));}},15000);
  function connectEvents(){const epoch=connectionEpoch,events=new WebSocket(url('/ws/events'));eventsSocket=events;events.onmessage=event=>{if(!online||epoch!==connectionEpoch)return;const data=JSON.parse(event.data);
    if(data.type==='offline'){goOffline(offlineReason(data.reason));return;}
    if(data.type==='observation'){ownsControl=data.ownsControl;controlAllowed=data.controlAllowed;taskBusy=data.taskBusy;update(data.state);}
    else if(data.type==='power'){observation.screenOn=data.screenOn;observation.locked=data.locked;observation.powerCollectedAt=data.powerCollectedAt;if(!interactive())void releaseInput();renderPhone();textState();details();}
    else if(data.type==='focus'){observation.focus=data.focus;observation.focusEpoch=data.focusEpoch;observation.focusCollectedAt=data.focusCollectedAt;observation.focusReason=data.focusReason;observation.snapshotId=data.snapshotId;if(data.focus){const index=observation.nodes.findIndex(n=>n.id===data.focus.id);if(index>=0)observation.nodes[index]=data.focus;}update(observation);}
    else if(data.type==='task')task(data.task);else if(data.type==='tasks')for(const t of data.tasks)task(t);
  };events.onclose=event=>{if(online&&epoch===connectionEpoch)goOffline(offlineReason(event.reason));};}
  function ensureVideoManager(){
    if(videoManager)return;
    videoManager=createVideoManager({providers:(boot.webrtc?.availableProviders||['coturn']),container:phone,paused:videoPaused,
      request:api,url:(path,id)=>{const value=new URL(url(path));value.searchParams.set('attemptId',id);return value.toString();},
      selected:()=>renderVideoState(),frame:()=>renderVideoState(),changed:()=>renderVideoState()});
    canvas.style.visibility='hidden';wssCanvas.hidden=true;
  }
  function connectVideo(){ensureVideoManager();videoManager!.start(videoMode);}
  function renderVideoState(){const state=videoManager?.snapshot(),active=videoManager?.active(),current=state?.current;
    const now=performance.now(),paused=videoPaused();if(previousVideoPaused&&!paused)frameRequiredAfter=now;previousVideoPaused=paused;
    if(active&&typeof current?.lastFrameAt==='number')lastDisplayedFrameAt=current.lastFrameAt;
    const freshness=videoFreshness({online,connecting,pauseReason:videoPauseReason(),active:!!active,lastFrameAt:lastDisplayedFrameAt,requiredAfter:frameRequiredAfter,now});
    const rtt=active?.provider==='wss'?current?.media?.roundTripMs:current?.selectedPair?.roundTripMs;
    const latency=online&&active&&Number.isFinite(rtt)&&rtt>=0?`网络往返 ${Math.round(rtt)} ms`:'网络往返待测';
    assign(q('.video-freshness-status'),freshness.title+'；'+freshness.detail+'；'+latency);
    q('.video-freshness-status').setAttribute('data-state',freshness.state);
    const banner=q<HTMLElement>('.video-freshness-banner');banner.hidden=freshness.state==='current';banner.dataset.state=freshness.state;
    assign(q('.video-freshness-title'),freshness.title);assign(q('.video-freshness-detail'),freshness.detail);
    phone.dataset.videoFreshness=freshness.state;phone.dataset.lastFrameAgeMs=freshness.lastFrameAgeMs===null?'':String(Math.round(freshness.lastFrameAgeMs));
    if(!state||!online)return;
    videoProvider=active?.provider;const media=current?.media||{};const size=active?.handle?.size()||state.attempts.find(a=>a.width&&a.height);
    if(size?.width&&size?.height){meta.width=size.width;meta.height=size.height;fitPhone();}
    Object.assign(phone.dataset,{videoProvider:videoProvider||'',videoConnection:current?.state||'connecting',iceMode:current?.mode||state.attempts[0]?.mode||'relay',
      mediaPath:videoProvider==='wss'?'wss':current?.path||'',framesRendered:String(current?.framesRendered||0),videoFramesDecoded:String(media.framesDecoded??media.decodedAndDrawnFrames??0),
      videoBytes:String(media.bytesReceived||0),videoPackets:String(media.packetsReceived||0),videoPaused:String(videoPaused())});
    q<HTMLElement>('.video-placeholder').hidden=!!active;
    assign(q('.video-status'),active?(videoPaused()?providerName(videoProvider)+' · 视频暂停，连接保留':providerName(videoProvider)+' 实时画面'):videoMode==='auto'?'正在并行连接视频':'正在连接 '+providerName(videoMode));
    qa('[data-video-mode]').forEach(i=>{const input=i as HTMLInputElement;input.checked=input.value===videoMode;input.disabled=input.value!=='auto'&&!(boot.webrtc?.availableProviders||['coturn']).includes(input.value);});
    networkInfo={state:current?.state||'connecting',provider:videoProvider||null,path:videoProvider==='wss'?'wss':current?.path||'',
      availableProviders:boot.webrtc?.availableProviders||['coturn'],attempts:state.history,connections:state.attempts,retrying:state.retrying,
      ...current,mode:videoMode,freshness,media:{...media,paused:videoPaused(),pauseReason:videoPauseReason()},environment:{userAgent:navigator.userAgent,secureContext:window.isSecureContext,assetVersion:boot.assetVersion}};
  }
  qa('[data-video-mode]').forEach(i=>i.addEventListener('change',()=>{const input=i as HTMLInputElement;if(!input.checked)return;videoMode=input.value as VideoMode;localStorage.setItem('android-video-mode',videoMode);connectVideo();}));
  const network=root.querySelector<HTMLDetailsElement>('.video-network');
  q('.video-network-copy').addEventListener('click',async()=>{const button=q<HTMLButtonElement>('.video-network-copy'),status=q('.video-network-copy-status'),value=q('.video-network-data').textContent||'';if(!value||value==='等待连接信息'){assign(status,'暂无诊断可复制');return;}button.disabled=true;assign(status,'正在复制');
    try{try{await navigator.clipboard.writeText(value);}catch{const previous=document.activeElement,field=document.createElement('textarea');field.value=value;field.readOnly=true;field.style.cssText='position:fixed;left:-9999px;top:0';document.body.append(field);field.select();try{if(!document.execCommand('copy'))throw new Error('Clipboard unavailable');}finally{field.remove();if(previous instanceof HTMLElement)previous.focus({preventScroll:true});}}assign(status,'已复制');}
    catch{assign(status,'复制失败，请手动选择诊断文本');}finally{button.disabled=false;}});
  async function updateNetwork(){if(!network?.open||!online||networkLoading)return;const epoch=connectionEpoch;networkLoading=true;try{const server=await api('/api/webrtc/status');if(online&&epoch===connectionEpoch)q('.video-network-data').textContent=JSON.stringify({browser:{...(networkInfo as object||{}),state:phone.dataset.videoConnection,provider:videoProvider||null},server},null,2);}catch(error){if(online&&epoch===connectionEpoch)q('.video-network-data').textContent=String(error);}finally{networkLoading=false;}}
  network?.addEventListener('toggle',()=>void updateNetwork());
  setInterval(()=>{renderVideoState();if(online)void updateNetwork();},1000);
  let lastActivitySent=0;const activity=()=>{if(!online||Date.now()-lastActivitySent<3000)return;lastActivitySent=Date.now();void api('/api/activity',{}).catch(()=>{});};for(const name of ['pointerdown','keydown','input','wheel','change'])root.addEventListener(name,activity,{capture:true,passive:true});
  keyboard();void connectPage();
}
