import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { Bridge } from './bridge.js';
import { Video } from './video.js';
import { ConsoleError, type AndroidNode, type Observation, type Selector, type Target, type ActionResult, type ApplicationState, type Navigation } from './types.js';
import {nodeTouchPoint,resolveClickOptions,type ClickOptions} from './click-options.js';
import {resolveNodeClick,nodeClickPointClear} from './node-click.js';
import {planGesture,type GestureKind,type GestureSpec,type Realism} from './gesture-plan.js';
import {chooseBackend,frameworkArgv,unsupportedReason,UNPROBED,type DeviceCapabilities,type ResolvedBackend} from './gesture-backend.js';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
// Monotonic milliseconds: gesture pacing must not follow a wall clock that
// can jump when the host syncs time mid-gesture.
const mono=()=>Number(process.hrtime.bigint()/1000000n);
const cancellablePause=(ms:number,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new ConsoleError('CANCELLED','任务已停止',409));};if(signal?.aborted){reject(new ConsoleError('CANCELLED','任务已停止',409));return;}const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);signal?.addEventListener('abort',abort,{once:true});});
/** Normalise the HTTP/SDK gesture payload into a planner spec. */
function gestureSpec(kind:string,p:any):GestureSpec {
  const seed=Number.isInteger(p?.seed)?p.seed:undefined;
  if(kind==='tap'||kind==='longPress')return {kind:kind as GestureKind,x:p.x,y:p.y,durationMs:p.durationMs,seed};
  if(kind==='pinch')return {kind:'pinch',x:p.x,y:p.y,durationMs:p.durationMs,startDistance:p.startDistance,endDistance:p.endDistance,seed};
  if(kind==='swipe'||kind==='drag'){
    const waypoints:Array<{x:number;y:number}>|undefined=Array.isArray(p.waypoints)
      ?p.waypoints.filter((w:any)=>Number.isFinite(w?.x)&&Number.isFinite(w?.y)).map((w:any)=>({x:Number(w.x),y:Number(w.y)}))
      :undefined;
    return {kind:kind as GestureKind,x1:p.x1,y1:p.y1,x2:p.x2,y2:p.y2,durationMs:p.durationMs,
      waypoints:waypoints&&waypoints.length>1?waypoints:undefined,seed};
  }
  throw new ConsoleError('INVALID_GESTURE','不支持的手势');
}

export const keyCodes: Record<string,number> = {BACK:4,HOME:3,RECENTS:187,ENTER:66,ESC:111,TAB:61,BACKSPACE:67,DELETE:112,UP:19,DOWN:20,LEFT:21,RIGHT:22,SPACE:62,PASTE:279,MOVE_HOME:122,MOVE_END:123,WAKEUP:224};

export class Device extends EventEmitter {
  readonly bridge: Bridge; readonly video: Video;
  state: Observation;
  owner?: string; private leaseUntil=0; activeTask?: string;
  authorize:(owner:string)=>void=()=>{};
  private tail: Promise<unknown> = Promise.resolve(); private collecting?: Promise<Observation>;
  private nextCapture?:Promise<Observation>;private resettingControl?:Promise<void>;
  private sessionActive=false;
  private pendingActions=0;private manualTouchOwner?:string;
  get touching(){return !!this.manualTouchOwner;}
  ownsTouch(owner:string){return this.manualTouchOwner===owner;}
  beginTouch(owner:string){
    if(this.pendingActions||this.manualTouchOwner)throw new ConsoleError('DEVICE_BUSY','设备正在执行其他动作，请稍后触摸',409);
    this.claim(owner);this.assertTouchReady();this.manualTouchOwner=owner;this.notify();
  }
  claimTouch(owner:string){if(this.manualTouchOwner!==owner)throw new ConsoleError('CONTROL_REPLACED','触摸会话已结束',409);this.claim(owner,undefined,true);this.assertTouchReady();}
  assertTouchReady(){if(!this.state.controlAvailable)throw new ConsoleError('NO_CONTROL','手机控制通道不可用，触摸未继续',503);if(this.state.powerError||!this.state.powerCollectedAt||Date.now()-this.state.powerCollectedAt>10000)throw new ConsoleError('POWER_UNKNOWN','手机状态已过期，请等待状态恢复',409);this.assertScreen();}
  endTouch(owner:string){if(this.manualTouchOwner===owner){this.manualTouchOwner=undefined;this.notify();}}
  async setConnected(active:boolean){this.sessionActive=active;if(active){void this.deviceCapabilities();await this.video.start();await this.video.confirmKeyboard(await this.bridge.call<boolean>('keyboardPresent').catch(()=>false));this.state.keyboardBackend=this.video.keyboardBackend;this.state.controlAvailable=!!this.video.client?.controller;await this.setKeepAwake(true);try{await this.collect();}catch{}}else{await this.setKeepAwake(false);await this.video.close();this.state.controlAvailable=false;this.state.keyboardBackend='offline';}this.notify();}
  private stopped=false; private generation=0; private hash='';private foregroundTimer=0;
  private fullTimer?: NodeJS.Timeout; private leaseTimer?: NodeJS.Timeout;
  private summaryTimer?:NodeJS.Timeout;
  async setKeepAwake(enabled:boolean){try{await this.bridge.call('awake',{enabled});this.state.keepAwake=enabled;this.state.keepAwakeError=undefined;}catch(error){this.state.keepAwake=false;this.state.keepAwakeError=String(error);}this.notify();}
  private powerTimer?:NodeJS.Timeout;private readingPower?:Promise<void>;
  private applications?:ApplicationState;private readingApplications?:Promise<ApplicationState>;
  constructor(serial:string,python:string,adb:string) {
    super();this.bridge=new Bridge(serial,python,adb);this.video=new Video(serial);
    this.state={connected:false,serial,model:'',android:'',system:'',width:0,height:0,rotation:0,screenOn:false,snapshotId:'',collectedAt:0,nodes:[],foregroundApp:'',focus:null,focusEpoch:0,uiError:'正在连接设备',videoError:null,controlAvailable:false};
    this.video.on('status',(error:string|null)=>{this.state.videoError=error;this.state.controlAvailable=!!this.video.client?.controller;this.notify();});
    this.video.on('diagnostic',(line:string)=>{if(/INJECT_EVENTS|SecurityException/.test(line)){this.state.controlAvailable=false;this.state.videoError='设备拒绝了调试操作，请检查事件注入权限、厂商调试安全设置或设备管理策略';this.notify();}});
  }
  private notify(){this.state.observationRevision=(this.state.observationRevision||0)+1;this.emit('observation',structuredClone(this.state));}
  publish(){this.notify();}
  refreshPower():Promise<void>{if(this.readingPower)return this.readingPower;this.readingPower=this.bridge.call<{screenOn:boolean;locked:boolean|null}>('power').then(power=>{Object.assign(this.state,power,{powerCollectedAt:Date.now(),powerError:null});this.emit('power',{...power,powerCollectedAt:this.state.powerCollectedAt});}).catch(error=>{this.state.powerError='手机状态读取失败';this.notify();throw error;}).finally(()=>{this.readingPower=undefined;});return this.readingPower;}
  assertScreen(){if(!this.state.screenOn)throw new ConsoleError('SCREEN_OFF','屏幕已关闭，请点击手机画面亮屏',409);if(this.state.locked!==false)throw new ConsoleError('DEVICE_LOCKED',this.state.locked?'手机已锁屏，请在手机上解锁':'手机解锁状态未知，请稍后重试',409);}
  async ensureInteractive(){if(!this.state.powerCollectedAt||Date.now()-this.state.powerCollectedAt>1500)await this.refreshPower();this.assertScreen();}
  async wake(session:string,task?:string){return this.enqueue(session,async()=>{await this.video.start();this.claim(session,task);await this.video.press(keyCodes.WAKEUP!);await this.bridge.call('unlock',{},15000,()=>this.claim(session,task));for(let i=0;i<8;i++){await pause(150);this.claim(session,task);await this.refreshPower();if(this.state.screenOn&&this.state.locked===false)break;}return {status:this.state.screenOn&&this.state.locked===false?'ok':'unlock_required',execution:'sent',verification:this.state.screenOn&&this.state.locked===false?'verified':'failed',screenOn:this.state.screenOn,locked:this.state.locked};},task);}
  async press(session:string,code:number,meta=0,task?:string){if(code===keyCodes.WAKEUP)return this.wake(session,task);return this.enqueue(session,async()=>{await this.ensureInteractive();this.claim(session,task);if(code===keyCodes.PASTE){await this.collect();if(!this.state.focus)throw new ConsoleError('NO_EDITABLE_FOCUS','粘贴前需确认手机文本焦点',409);}await this.video.press(code,meta);await this.afterApplicationAction();return {status:'ok',execution:'sent',verification:'not_verified',snapshotId:this.state.snapshotId};},task);}
  async start() {
    try{await this.setKeepAwake(false);Object.assign(this.state,await this.bridge.call('info'));await this.refreshPower();await this.collect();}catch(error){this.state.uiError=String(error);}

    const summary=async()=>{if(this.stopped)return;if(!this.sessionActive||this.touching){this.summaryTimer=setTimeout(summary,15000);return;}try{this.state.summary=await this.bridge.call('summary');this.notify();}catch{}this.summaryTimer=setTimeout(summary,15000);};void summary();
    this.notify();
    const poll=async()=>{if(this.stopped)return;if(this.sessionActive&&!this.touching)try{await this.collect();if(!this.video.client){await this.video.start();await this.video.confirmKeyboard(await this.bridge.call<boolean>('keyboardPresent').catch(()=>false));this.state.keyboardBackend=this.video.keyboardBackend;}}catch{}this.fullTimer=setTimeout(poll,1500);};
    this.fullTimer=setTimeout(poll,1500);
    const power=async()=>{if(this.stopped)return;if(this.sessionActive)try{await this.refreshPower();}catch{}if(!this.stopped)this.powerTimer=setTimeout(power,2000);};this.powerTimer=setTimeout(power,1000);
    this.leaseTimer=setInterval(()=>{if(this.owner&&Date.now()>this.leaseUntil&&!this.activeTask&&!this.touching){this.owner=undefined;void this.video.release();this.notify();}},2000);
  }
  collect({fresh=false}:{fresh?:boolean}={}):Promise<Observation> {
    if(this.collecting){
      if(!fresh)return this.collecting;
      if(!this.nextCapture)this.nextCapture=this.collecting.catch(()=>{}).then(()=>{this.nextCapture=undefined;return this.collect();});
      return this.nextCapture;
    }
    this.collecting=this.readTree().finally(()=>{this.collecting=undefined;});return this.collecting;
  }
  private async readTree() {
    const captureStartedAt=Date.now();
    try {
      const result=await this.bridge.call<{nodes:AndroidNode[];width:number;height:number;rotation:number;screenOn:boolean;locked:boolean|null;windowId:string;elapsedMs:number}>('snapshot');
      const collectedAt=Date.now();
      const previousFocus=this.state.focus?.id;
      const hash=createHash('sha256').update(JSON.stringify(result.nodes)).digest('hex');
      if(hash!==this.hash){this.hash=hash;this.state.snapshotId='ui-'+(++this.generation);}
      const recentPower=await this.refreshPower().then(()=>({screenOn:this.state.screenOn,locked:this.state.locked})).catch(()=>({screenOn:result.screenOn,locked:result.locked}));
      Object.assign(this.state,{connected:true,nodes:result.nodes,width:result.width,height:result.height,rotation:result.rotation,...recentPower,windowId:result.windowId,uiElapsedMs:result.elapsedMs,collectedAt,captureStartedAt,captureSeq:(this.state.captureSeq||0)+1,uiError:null});
      this.state.foregroundApp=result.nodes.find(n=>n.package&&!n.package.startsWith('com.android.systemui'))?.package||result.nodes[0]?.package||'';
      const fields=result.nodes.filter(n=>n.focused&&n.editable&&!n.password);this.state.focus=fields.length===1?fields[0]!:null;this.state.focusReason=fields.length>1?'AMBIGUOUS_FOCUS':fields.length===1?null:'NO_EDITABLE_FOCUS';
      if(previousFocus!==this.state.focus?.id)this.state.focusEpoch++;
      this.notify();return structuredClone(this.state);
    } catch(error){if(error instanceof ConsoleError&&['BRIDGE_EXIT','BRIDGE_TIMEOUT','BRIDGE_CLOSED'].includes(error.code))this.state.connected=false;this.state.foregroundApp='';this.state.uiError=String(error);if(this.state.focus){this.state.focus=null;this.state.focusEpoch++;}this.notify();throw error;}
  }
  claim(session:string,task?:string,manual=false) {
    this.authorize(session);
    if(this.resettingControl)throw new ConsoleError('CONTROL_RESETTING','正在释放控制，请稍后操作',409);
    if(this.manualTouchOwner&&(!manual||this.manualTouchOwner!==session))throw new ConsoleError('DEVICE_BUSY','触摸手势进行中，请松手后执行其他动作',409);
    if(task&&this.activeTask!==task)throw new ConsoleError('CANCELLED','任务已停止，未执行后续动作',409);
    if(this.activeTask&&this.activeTask!==task)throw new ConsoleError('TASK_BUSY','脚本正在控制设备，请先停止任务',409);
    if(this.owner&&this.owner!==session&&Date.now()<this.leaseUntil)throw new ConsoleError('CONTROL_BUSY','设备由另一个浏览器会话控制',409);
    const changed=this.owner!==session;this.owner=session;this.leaseUntil=Date.now()+30000;if(changed)this.notify();
  }
  heartbeat(session:string){if(this.owner===session)this.leaseUntil=Date.now()+30000;}
  canClaim(session:string){return !this.activeTask&&!this.touching&&!this.pendingActions&&!this.resettingControl&&(!this.owner||this.owner===session||Date.now()>=this.leaseUntil);}
  async release(session:string){if(this.owner!==session)return;if(this.activeTask)throw new ConsoleError('TASK_BUSY','请先停止脚本再释放设备',409);await this.video.release();this.endTouch(session);if(this.owner===session)this.owner=undefined;this.notify();}
  resetControl():Promise<void>{
    if(this.resettingControl)return this.resettingControl;
    this.resettingControl=this.tail.catch(()=>{}).then(()=>this.video.release()).catch(error=>{this.state.controlAvailable=false;this.state.videoError='控制释放失败，请重新连接';throw error;}).finally(()=>{this.resettingControl=undefined;this.notify();});
    this.notify();return this.resettingControl;
  }
  async drain(){await this.resetControl();}
  enqueue<T>(session:string,fn:()=>Promise<T>,task?:string,announce=true):Promise<T>{this.claim(session,task);const revision=this.state.observationRevision;this.pendingActions++;if(announce)this.notify();const work=this.tail.then(async()=>{this.claim(session,task);return fn();}).finally(()=>{this.pendingActions--;if(announce||!this.pendingActions&&this.state.observationRevision!==revision)this.notify();});this.tail=work.catch(()=>{});return work;}
  async target(target:Target):Promise<AndroidNode> {
    await this.collect({fresh:true});const node=this.state.nodes.find(n=>n.id===target.id);
    if(!node||node.fingerprint!==target.fingerprint||target.windowId&&target.windowId!==this.state.windowId)throw new ConsoleError('STALE_TARGET','所选节点已变化，请重新查看属性',409);
    if(!node.enabled||!node.visible)throw new ConsoleError('UNAVAILABLE_TARGET','目标不可用或不在有效屏幕区域',409);
    return node;
  }
  find(selector:Selector):AndroidNode {
    if(!selector||!Object.keys(selector).length)throw new ConsoleError('INVALID_SELECTOR','选择器不能为空');
    const allowed=['text','resourceId','description','className','package'];
    if(Object.keys(selector).some(k=>!allowed.includes(k)))throw new ConsoleError('INVALID_SELECTOR','不支持的选择器字段');
    const matches=this.state.nodes.filter(n=>Object.entries(selector).every(([k,v])=>n[k as keyof AndroidNode]===v));
    if(!matches.length)throw new ConsoleError('TARGET_NOT_FOUND','未找到匹配节点',404);
    if(matches.length!==1)throw new ConsoleError('AMBIGUOUS_TARGET','匹配到多个节点，请补充 resourceId 或 className',409);
    return matches[0]!;
  }
  private coordinates(x:number,y:number) {
    const {width,height}=this.state;
    if(!width||!height||!this.video.width||!this.video.height||Math.abs(width/height-this.video.width/this.video.height)>0.04)throw new ConsoleError('STALE_DISPLAY','视频与 UI 尺寸未就绪或方向不同，请等待刷新',409);
    if(x<0||y<0||x>=width||y>=height)throw new ConsoleError('INVALID_COORDINATES','手机坐标超出显示范围');
    return {x:x*this.video.width/width,y:y*this.video.height/height};
  }
  private async tapAt(x:number,y:number,duration?:number){
    const hold=duration??planGesture({kind:'tap'}).holdMs!;
    const p=this.coordinates(x,y);
    await this.video.touch(0,0n,p.x,p.y);
    try{await pause(hold);}finally{await this.video.touch(1,0n,p.x,p.y);}
  }
  async nodeAction(session:string,target:Target|null,action:string,value?:unknown,task?:string,clickOptions?:ClickOptions,selector?:Selector) {
    const options=resolveClickOptions(clickOptions);
    return this.enqueue(session,async()=>{
      await this.ensureInteractive();
      let n:AndroidNode;
      if(target)n=await this.target(target);else{await this.collect({fresh:true});n=this.find(selector!);if(!n.enabled||!n.visible)throw new ConsoleError('UNAVAILABLE_TARGET','目标不可用或不在有效屏幕区域',409);}
      let textVerification:ActionResult['verification'];let point:{x:number;y:number}|undefined,actionTarget:AndroidNode|undefined;
      // realism:'off' keeps the old fixed 60 ms press; otherwise the hold
      // comes from the measured 70-108 ms distribution.
      const touch=async(duration?:number)=>{point=nodeTouchPoint(n,this.state.width,this.state.height,options.jitter);await this.tapAt(point.x,point.y,duration??(options.realism==='off'?60:undefined));};
      this.claim(session,task);
      if(action!=='setText'&&!this.state.controlAvailable)throw new ConsoleError('NO_CONTROL','设备未允许触摸或按键注入',503);
      if(action==='setText') {
        if(!n.editable||n.password||typeof value!=='string'||value.length>32768)throw new ConsoleError('UNSUPPORTED_ACTION','该节点不支持文本替换');
        const confirmation=await this.bridge.call('setText',{nodeId:n.id,selector:n.selector,instance:n.instance,bounds:n.bounds,windowId:this.state.windowId,text:value},15000,()=>{this.claim(session,task);this.assertScreen();});
        textVerification=confirmation.verification||('text' in confirmation?(confirmation.text===value?'verified':'failed'):'inconclusive');
      } else if(action==='setChecked') {
        if(!n.checkable||!n.clickable||typeof value!=='boolean')throw new ConsoleError('UNSUPPORTED_ACTION','该节点未报告可用开关能力');
        if(n.checked!==value)await touch();
      } else if(action==='focus') {if(!n.editable)throw new ConsoleError('UNSUPPORTED_ACTION','节点不是输入框');await this.bridge.call('clickNode',{selector:n.selector,instance:n.instance,bounds:n.bounds},15000,()=>this.claim(session,task));}
      else if(action==='click') {
        const resolved=resolveNodeClick(n,this.state.nodes,this.state.width,this.state.height);
        if(!resolved)throw new ConsoleError('UNSUPPORTED_ACTION','节点没有可用的点击目标，请选择所在行或直接操作画面');
        actionTarget=resolved.target;point=nodeTouchPoint({...n,bounds:resolved.bounds},this.state.width,this.state.height,options.jitter);
        if(n.id!==actionTarget.id&&!nodeClickPointClear(n,this.state.nodes,point.x,point.y))throw new ConsoleError('UNSUPPORTED_ACTION','落点有其他控件，未发送点击');
        if(this.state.windowId)await this.bridge.call('validateNodeClick',{windowId:this.state.windowId,source:n,actionTarget,point},15000,()=>{this.claim(session,task);this.assertScreen();});
        this.claim(session,task);await this.tapAt(point.x,point.y);
      }
      else if(action==='longPress') {if(!n.longClickable)throw new ConsoleError('UNSUPPORTED_ACTION','节点未报告长按能力');await touch(typeof value==='number'?Math.min(Math.max(value,400),3000):700);}
      else throw new ConsoleError('UNSUPPORTED_ACTION','不支持的节点动作');
      await pause(100);await this.afterApplicationAction();
      if(action==='setText'&&textVerification!=='verified'){
        const error=new ConsoleError(textVerification==='failed'?'TEXT_VERIFY_FAILED':'TEXT_RESULT_UNKNOWN',textVerification==='failed'?'填写已发送，但手机文字与原文不同；请检查手机，不会自动重试':'填写已发送，无法确认原目标内容；请先观察手机，不要直接重试',409);
        error.execution='sent';error.verification=textVerification;throw error;
      }
      if(action==='setChecked'){const current=this.state.nodes.find(x=>x.id===n.id);if(this.state.uiError||!current||current.checked!==value){const error=new ConsoleError(this.state.uiError?'VERIFY_RESULT_UNKNOWN':'VERIFY_FAILED',this.state.uiError?'无法读取开关结果，请先观察手机':'开关状态未达到期望值，请观察手机',409);if(point)error.execution='sent';error.verification=this.state.uiError?'inconclusive':'failed';throw error;}}
      return {requestId:randomUUID(),status:'ok',execution:'sent',verification:action==='setText'?textVerification:action==='setChecked'?'verified':action==='focus'&&this.state.focus?.id===n.id?'verified':'not_verified',backend:action==='setText'?'uiautomator2.setText':action==='focus'?'uiautomator2.focus':'scrcpy-coordinate-compatibility',...(point?{jitter:options.jitter,point}:{}),...(actionTarget?{sourceTarget:n.id,actionTarget:actionTarget.id}:{}),snapshotId:this.state.snapshotId,uiError:this.state.uiError};
    },task);
  }
  async panel(session:string,kind:'notifications'|'settings',task?:string){return this.enqueue(session,async()=>{await this.ensureInteractive();await this.video.panel(kind);await this.afterApplicationAction();return {execution:'sent',verification:'not_verified',snapshotId:this.state.snapshotId};},task);}
  async readText(session:string,target:Target){
    return this.enqueue(session,async()=>{
      await this.ensureInteractive();const n=await this.target(target);
      if(!n.editable||n.password)throw new ConsoleError('UNSUPPORTED_ACTION','该节点不支持读取文字');
      return this.bridge.call<{text:string}>('readText',{selector:n.selector,instance:n.instance,bounds:n.bounds,windowId:this.state.windowId});
    });
  }
  async appState(refreshCatalog=false):Promise<ApplicationState> {
    if(this.readingApplications){await this.readingApplications;if(!refreshCatalog&&this.applications)return this.applications;}
    if(!refreshCatalog&&this.applications&&Date.now()-this.applications.collectedAt<3000)return this.applications;
    this.readingApplications=this.bridge.call<ApplicationState>('appState',{refreshCatalog}).then(state=>this.applications=state).finally(()=>{this.readingApplications=undefined;});
    return this.readingApplications;
  }
  navigation():Promise<Navigation>{return this.bridge.call('navigation');}
  private async afterApplicationAction(){this.applications=undefined;try{await this.collect({fresh:true});}catch{}}
  async openApp(session:string,packageName:string,component?:string,task?:string) {
    return this.enqueue(session,async()=>{const result=await this.bridge.call('openApp',{packageName,component},15000,()=>this.claim(session,task));await this.afterApplicationAction();return {status:'ok',execution:'sent',verification:this.state.foregroundApp===packageName?'verified':'inconclusive',result,snapshotId:this.state.snapshotId,uiError:this.state.uiError};},task);
  }
  async switchTask(session:string,taskId:number,fingerprint?:string,task?:string) {
    return this.enqueue(session,async()=>{
      if(!Number.isSafeInteger(taskId)||taskId<0)throw new ConsoleError('INVALID_TASK','任务编号无效');
      const nav=await this.navigation(),target=nav.tasks.find(t=>t.taskId===taskId);
      if(!target||fingerprint&&target.fingerprint!==fingerprint)throw new ConsoleError('STALE_TASK','任务已变化，请刷新近期任务',409);
      if(!target.switchable)throw new ConsoleError('UNAVAILABLE_TASK','只有历史记录、没有可聚焦 Activity 的任务不能直接切换',409);
      if(nav.locked!==false)throw new ConsoleError('DEVICE_LOCKED','请手动解锁手机后切换任务',409);
      this.claim(session,task);const result=await this.bridge.call('switchTask',{taskId,fingerprint:target.fingerprint},15000,()=>this.claim(session,task));
      await this.afterApplicationAction();return {status:'ok',execution:'sent',verification:'verified',result,snapshotId:this.state.snapshotId,uiError:this.state.uiError};
    },task);
  }
  async back(session:string,options:{steps?:number;stopOnTaskChange?:boolean;intervalMs?:number}={},task?:string,signal?:AbortSignal) {
    const steps=options.steps??1,intervalMs=options.intervalMs??350;
    if(!Number.isInteger(steps)||steps<1||steps>10||!Number.isFinite(intervalMs)||intervalMs<100||intervalMs>2000)throw new ConsoleError('INVALID_BACK','返回次数需为 1–10，间隔需为 100–2000 ms');
    return this.enqueue(session,async()=>{
      await this.ensureInteractive();let nav=await this.navigation();const initial=nav.current,initialUser=nav.userId,transitions:{before:Navigation['current'];after:Navigation['current']}[]=[];
      if(nav.locked!==false||!initial||initial.userId!==initialUser)throw new ConsoleError('NO_NAVIGATION','请解锁手机并确认当前任务后再返回',409);
      const changed=(next:Navigation)=>!next.current||next.userId!==initialUser||next.current.taskId!==initial.taskId||next.current.component.split('/')[0]!==initial.component.split('/')[0];
      let reason='completed';
      for(let i=0;i<steps;i++){
        if(signal?.aborted)throw new ConsoleError('CANCELLED','任务已停止',409);
        const before=await this.navigation();
        if(before.locked!==false){reason='locked';break;}
        if(before.userId!==initialUser){reason='user_changed';break;}
        if(!before.current){reason='foreground_unknown';break;}
        if(options.stopOnTaskChange!==false&&changed(before)){reason='task_changed';break;}
        if(!this.state.controlAvailable)throw new ConsoleError('NO_CONTROL','设备未允许返回按键',503);
        this.claim(session,task);this.assertScreen();await this.video.press(keyCodes.BACK!);
        // Observe between presses: BACK may dismiss an IME or leave the task.
        transitions.push({before:before.current,after:null});
        try{await cancellablePause(intervalMs,signal);nav=await this.navigation();}catch(error){if(signal?.aborted)throw error;throw new ConsoleError('BACK_PARTIAL','已发送 '+transitions.length+' 次返回，但无法确认后续状态；未重放：'+String(error),503);}
        transitions[transitions.length-1]!.after=nav.current;
        if(nav.locked!==false){reason='locked';break;}
        if(nav.userId!==initialUser){reason='user_changed';break;}
        if(!nav.current){reason='foreground_unknown';break;}
        if(options.stopOnTaskChange!==false&&changed(nav)){reason='task_changed';break;}
      }
      await this.afterApplicationAction();return {status:reason==='completed'?'ok':'stopped',requested:steps,completed:transitions.length,reason,transitions,snapshotId:this.state.snapshotId,uiError:this.state.uiError};
    },task);
  }
  private capabilities?:Promise<DeviceCapabilities>;
  private resolved?:DeviceCapabilities;

  async gesture(session:string,kind:string,p:any,task?:string,signal?:AbortSignal) {
    return this.enqueue(session,async()=>{
      await this.ensureInteractive();this.claim(session,task);
      const realism:Realism=p.realism??'auto';
      // Hot path: read the cached probe. An explicit framework request is the
      // one case where a guess could send the wrong command, so wait for it.
      const caps=this.resolved??(realism==='framework'?await this.deviceCapabilities():UNPROBED);
      const run=async(spec:GestureSpec)=>{const {backend,detail}=await this.performGesture(spec,realism,caps,signal,session,task);return {backend,detail};};
      let backend:ResolvedBackend;
      let detail:string;
      if(kind==='doubleTap'){
        // A double tap is two taps with a real gap, not one long press.
        const first=await run(gestureSpec('tap',p));
        await cancellablePause(100,signal);
        this.claim(session,task);this.assertScreen();
        const second=await run(gestureSpec('tap',p));
        backend=first.backend;detail=`doubleTap(${first.detail}+${second.detail})`;
      } else {
        const one=await run(gestureSpec(kind,p));
        backend=one.backend;detail=one.detail;
      }
      await this.afterApplicationAction();
      return {status:'ok',execution:'sent',verification:'not_verified',backend:`gesture:${backend}:${detail}`,snapshotId:this.state.snapshotId,uiError:this.state.uiError};
    },task);
  }

  /**
   * Probe once per connection: does this device's `input` command offer
   * `pswipe`? Depends on the image, not on the gesture, so it is done when the
   * connection opens and read synchronously afterwards.
   */
  private deviceCapabilities():Promise<DeviceCapabilities>{
    return this.capabilities??=this.bridge.call<DeviceCapabilities>('capabilities',{},15000)
      .then(caps=>{
        // The sandbox image is the one whose panel we measured: it reports
        // pressure 1.0 even on lift-off. Only claim that where we know it.
        if(caps.pswipe)this.video.pressureMode='panel';
        this.resolved=caps;
        return caps;
      })
      .catch(()=>{this.resolved=UNPROBED;return UNPROBED;});
  }

  private async performGesture(spec:GestureSpec,realism:Realism,caps:DeviceCapabilities,signal:AbortSignal|undefined,session:string,task?:string){
    const backend=chooseBackend(realism,caps,spec.kind);
    if(backend==='unsupported')throw new ConsoleError('UNREALISTIC_INPUT',unsupportedReason(realism,caps,spec.kind),409);
    if(backend!=='framework'&&!this.state.controlAvailable)throw new ConsoleError('NO_CONTROL','设备未允许触摸注入',503);
    if(backend==='framework'){
      const plan=planGesture(spec);
      const argv=frameworkArgv(spec,plan.holdMs??0,this.state.width,this.state.height);
      // The device synthesises the whole gesture; the call returns when it ends.
      await this.bridge.call('inputGesture',{argv},Math.min(plan.durationMs+8000,60000),()=>{this.claim(session,task);this.assertScreen();});
      return {backend,detail:`${plan.durationMs}ms`};
    }
    if(backend==='client'){
      const ms=await this.playGesture(spec,signal,session,task);
      return {backend,detail:`${ms}ms`};
    }
    await this.legacyGesture(spec.kind,spec,signal,session,task);
    return {backend,detail:'legacy'};
  }

  /**
   * Replay a planned trajectory through scrcpy.
   *
   * Samples are paced against a monotonic deadline, not chained sleeps: points
   * that are 4 ms apart must arrive 4 ms apart, and chained timers accumulate
   * drift. If an injection takes longer than one grid step the schedule falls
   * behind rather than skipping points -- a skipped point is a visible jump,
   * being 20 ms late is not.
   */
  private async playGesture(spec:GestureSpec,signal:AbortSignal|undefined,session:string,task?:string){
    const plan=planGesture(spec);
    if(plan.kind==='tap'||plan.kind==='longPress'){
      const p=plan.samples[0]!.points[0]!;
      const pt=this.coordinates(p.x,p.y);
      await this.video.touch(0,0n,pt.x,pt.y);
      try{await cancellablePause(plan.holdMs!,signal);}
      finally{await this.video.touch(1,0n,pt.x,pt.y);}
      return plan.durationMs;
    }
    const started=mono();
    const lift=this.coordinates(plan.samples[0]!.points[0]!.x,plan.samples[0]!.points[0]!.y);
    let sent=0;
    try{
      for(const sample of plan.samples){
        const wait=started+sample.t-mono();
        if(wait>0)await cancellablePause(Math.max(0,Math.ceil(wait)),signal);
        if(signal?.aborted)throw new ConsoleError('CANCELLED','任务已停止',409);
        this.claim(session,task);this.assertScreen();
        for(const point of sample.points){
          const pt=this.coordinates(point.x,point.y);
          await this.video.touch(sent===0?0:2,BigInt(point.id),pt.x,pt.y);
          lift.x=pt.x;lift.y=pt.y;
        }
        sent++;
      }
    }finally{
      // Lift at the last point actually emitted. The old code always lifted at
      // the intended destination, so a cancelled swipe teleported the pointer.
      await this.video.touch(1,0n,lift.x,lift.y);
    }
    return Math.round(mono()-started);
  }

  /** The pre-realism shape, kept verbatim so `realism:'off'` stays comparable. */
  private async legacyGesture(kind:string,spec:GestureSpec,signal:AbortSignal|undefined,session:string,task?:string){
    if(kind==='tap'||kind==='longPress'){
      await this.tapAt(spec.x??0,spec.y??0,kind==='longPress'?Math.min(spec.durationMs??700,3000):50);
    } else if(kind==='swipe'||kind==='drag'){
      const a=this.coordinates(spec.x1??0,spec.y1??0),b=this.coordinates(spec.x2??0,spec.y2??0);
      const ms=Math.min(Math.max(spec.durationMs??350,100),5000);
      await this.video.touch(0,0n,a.x,a.y);
      try{for(let i=1;i<=20;i++){if(signal?.aborted)throw new ConsoleError('CANCELLED','任务已停止');await pause(ms/20);this.claim(session,task);this.assertScreen();await this.video.touch(2,0n,a.x+(b.x-a.x)*i/20,a.y+(b.y-a.y)*i/20);}}
      finally{await this.video.touch(1,0n,b.x,b.y);}
    } else if(kind==='pinch'){
      const x=spec.x??this.state.width/2,y=spec.y??this.state.height/2;
      const start=spec.startDistance??100,end=spec.endDistance??400;
      const a=this.coordinates(x-start/2,y),b=this.coordinates(x+start/2,y);
      await this.video.touch(0,0n,a.x,a.y);await this.video.touch(0,1n,b.x,b.y);
      try{for(let i=1;i<=20;i++){if(signal?.aborted)throw new ConsoleError('CANCELLED','任务已停止');this.claim(session,task);this.assertScreen();const distance=start+(end-start)*i/20;const left=this.coordinates(x-distance/2,y),right=this.coordinates(x+distance/2,y);await this.video.touch(2,0n,left.x,left.y);await this.video.touch(2,1n,right.x,right.y);await pause(20);}}
      finally{await this.video.release();}
    } else throw new ConsoleError('INVALID_GESTURE','不支持的手势');
  }

  async stop(){this.stopped=true;clearTimeout(this.summaryTimer);await this.setKeepAwake(false);clearTimeout(this.fullTimer);clearTimeout(this.powerTimer);clearInterval(this.leaseTimer);await this.video.close();this.bridge.close();}
}
