import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { Bridge } from './bridge.js';
import { Video } from './video.js';
import { ConsoleError, type AndroidNode, type Observation, type Selector, type Target, type ActionResult, type ApplicationState, type Navigation } from './types.js';
import {nodeTouchPoint,resolveClickOptions,type ClickOptions} from './click-options.js';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const cancellablePause=(ms:number,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new ConsoleError('CANCELLED','任务已停止',409));};if(signal?.aborted){reject(new ConsoleError('CANCELLED','任务已停止',409));return;}const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);signal?.addEventListener('abort',abort,{once:true});});
export const keyCodes: Record<string,number> = {BACK:4,HOME:3,RECENTS:187,ENTER:66,ESC:111,TAB:61,BACKSPACE:67,DELETE:112,UP:19,DOWN:20,LEFT:21,RIGHT:22,SPACE:62,PASTE:279,MOVE_HOME:122,MOVE_END:123,WAKEUP:224};

export class Device extends EventEmitter {
  readonly bridge: Bridge; readonly video: Video;
  state: Observation;
  owner?: string; private leaseUntil=0; activeTask?: string;
  authorize:(owner:string)=>void=()=>{};
  private tail: Promise<unknown> = Promise.resolve(); private collecting?: Promise<Observation>;
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
  async setConnected(active:boolean){this.sessionActive=active;if(active){await this.video.start();await this.video.confirmKeyboard(await this.bridge.call<boolean>('keyboardPresent').catch(()=>false));this.state.keyboardBackend=this.video.keyboardBackend;this.state.controlAvailable=!!this.video.client?.controller;await this.setKeepAwake(true);try{await this.collect();}catch{}}else{await this.setKeepAwake(false);await this.video.close();this.state.controlAvailable=false;this.state.keyboardBackend='offline';}this.notify();}
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
  private notify(){this.emit('observation',this.state);}
  publish(){this.notify();}
  refreshPower():Promise<void>{if(this.readingPower)return this.readingPower;this.readingPower=this.bridge.call<{screenOn:boolean;locked:boolean|null}>('power').then(power=>{const changed=this.state.screenOn!==power.screenOn||this.state.locked!==power.locked;Object.assign(this.state,power,{powerCollectedAt:Date.now(),powerError:null});if(changed)this.emit('power',{...power,powerCollectedAt:this.state.powerCollectedAt});}).catch(error=>{this.state.powerError='手机状态读取失败';this.notify();throw error;}).finally(()=>{this.readingPower=undefined;});return this.readingPower;}
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
  collect():Promise<Observation> {
    if(this.collecting)return this.collecting;
    this.collecting=this.readTree().finally(()=>{this.collecting=undefined;});return this.collecting;
  }
  private async readTree() {
    try {
      const result=await this.bridge.call<{nodes:AndroidNode[];width:number;height:number;rotation:number;screenOn:boolean;locked:boolean|null;windowId:string;elapsedMs:number}>('snapshot');
      const previousFocus=this.state.focus?.id;
      const hash=createHash('sha256').update(JSON.stringify(result.nodes)).digest('hex');
      if(hash!==this.hash){this.hash=hash;this.state.snapshotId='ui-'+(++this.generation);}
      const recentPower=await this.refreshPower().then(()=>({screenOn:this.state.screenOn,locked:this.state.locked})).catch(()=>({screenOn:result.screenOn,locked:result.locked}));
      Object.assign(this.state,{connected:true,nodes:result.nodes,width:result.width,height:result.height,rotation:result.rotation,...recentPower,windowId:result.windowId,uiElapsedMs:result.elapsedMs,collectedAt:Date.now(),uiError:null});
      this.state.foregroundApp=result.nodes.find(n=>n.package&&!n.package.startsWith('com.android.systemui'))?.package||result.nodes[0]?.package||'';
      const fields=result.nodes.filter(n=>n.focused&&n.editable&&!n.password);this.state.focus=fields.length===1?fields[0]!:null;this.state.focusReason=fields.length>1?'AMBIGUOUS_FOCUS':fields.length===1?null:'NO_EDITABLE_FOCUS';
      if(previousFocus!==this.state.focus?.id)this.state.focusEpoch++;
      this.notify();return this.state;
    } catch(error){this.state.connected=false;this.state.foregroundApp='';this.state.uiError=String(error);if(this.state.focus){this.state.focus=null;this.state.focusEpoch++;}this.notify();throw error;}
  }
  claim(session:string,task?:string,manual=false) {
    this.authorize(session);
    if(this.manualTouchOwner&&(!manual||this.manualTouchOwner!==session))throw new ConsoleError('DEVICE_BUSY','触摸手势进行中，请松手后执行其他动作',409);
    if(task&&this.activeTask!==task)throw new ConsoleError('CANCELLED','任务已停止，未执行后续动作',409);
    if(this.activeTask&&this.activeTask!==task)throw new ConsoleError('TASK_BUSY','脚本正在控制设备，请先停止任务',409);
    if(this.owner&&this.owner!==session&&Date.now()<this.leaseUntil)throw new ConsoleError('CONTROL_BUSY','设备由另一个浏览器会话控制',409);
    const changed=this.owner!==session;this.owner=session;this.leaseUntil=Date.now()+30000;if(changed)this.notify();
  }
  heartbeat(session:string){if(this.owner===session)this.leaseUntil=Date.now()+30000;}
  canClaim(session:string){return !this.activeTask&&!this.touching&&(!this.owner||this.owner===session||Date.now()>=this.leaseUntil);}
  async release(session:string){if(this.owner!==session)return;if(this.activeTask)throw new ConsoleError('TASK_BUSY','请先停止脚本再释放设备',409);await this.video.release();this.endTouch(session);if(this.owner===session)this.owner=undefined;this.notify();}
  async drain(){await this.tail.catch(()=>{});await this.video.release();}
  enqueue<T>(session:string,fn:()=>Promise<T>,task?:string):Promise<T>{this.claim(session,task);this.pendingActions++;const work=this.tail.then(async()=>{this.claim(session,task);return fn();}).finally(()=>this.pendingActions--);this.tail=work.catch(()=>{});return work;}
  async target(target:Target):Promise<AndroidNode> {
    await this.collect();const node=this.state.nodes.find(n=>n.id===target.id);
    if(!node||node.fingerprint!==target.fingerprint)throw new ConsoleError('STALE_TARGET','所选节点已变化，请重新查看属性',409);
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
  private async tapAt(x:number,y:number,duration=60){const p=this.coordinates(x,y);await this.video.touch(0,0n,p.x,p.y);try{await pause(duration);}finally{await this.video.touch(1,0n,p.x,p.y);}}
  async nodeAction(session:string,target:Target,action:string,value?:unknown,task?:string,clickOptions?:ClickOptions) {
    const options=resolveClickOptions(clickOptions);
    return this.enqueue(session,async()=>{
      await this.ensureInteractive();
      const n=await this.target(target);let textVerification:ActionResult['verification'];let point:{x:number;y:number}|undefined;
      const touch=async(duration=60)=>{point=nodeTouchPoint(n,this.state.width,this.state.height,options.jitter);await this.tapAt(point.x,point.y,duration);};
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
      else if(action==='click') {if(!n.clickable)throw new ConsoleError('UNSUPPORTED_ACTION','节点未报告点击能力');await touch();}
      else if(action==='longPress') {if(!n.longClickable)throw new ConsoleError('UNSUPPORTED_ACTION','节点未报告长按能力');await touch(typeof value==='number'?Math.min(Math.max(value,400),3000):700);}
      else throw new ConsoleError('UNSUPPORTED_ACTION','不支持的节点动作');
      await pause(100);if(action==='setText')await this.afterApplicationAction();else await this.collect();
      if(action==='setText'&&textVerification!=='verified'){
        const error=new ConsoleError(textVerification==='failed'?'TEXT_VERIFY_FAILED':'TEXT_RESULT_UNKNOWN',textVerification==='failed'?'填写已发送，但手机文字与原文不同；请检查手机，不会自动重试':'填写已发送，无法确认原目标内容；请先观察手机，不要直接重试',409);
        error.execution='sent';error.verification=textVerification;throw error;
      }
      if(action==='setChecked'){const current=this.state.nodes.find(x=>x.id===n.id);if(!current||current.checked!==value)throw new ConsoleError('VERIFY_FAILED','开关状态未达到期望值，请观察手机',409);}
      return {requestId:randomUUID(),status:'ok',execution:'sent',verification:action==='setText'?textVerification:action==='setChecked'?'verified':action==='focus'&&this.state.focus?.id===n.id?'verified':'not_verified',backend:action==='setText'?'uiautomator2.setText':action==='focus'?'uiautomator2.focus':'scrcpy-coordinate-compatibility',...(point?{jitter:options.jitter,point}:{}),snapshotId:this.state.snapshotId};
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
  private async afterApplicationAction(){this.applications=undefined;if(this.collecting)try{await this.collecting;}catch{}try{await this.collect();}catch{}}
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
  async gesture(session:string,kind:string,p:any,task?:string,signal?:AbortSignal) {
    return this.enqueue(session,async()=>{
      await this.ensureInteractive();this.claim(session,task);
      if(!this.state.controlAvailable)throw new ConsoleError('NO_CONTROL','设备未允许触摸注入',503);
      if(kind==='tap'||kind==='longPress'||kind==='doubleTap'){await this.tapAt(p.x,p.y,kind==='longPress'?Math.min(p.durationMs??700,3000):50);if(kind==='doubleTap'){await pause(100);if(signal?.aborted)throw new ConsoleError('CANCELLED','任务已停止',409);this.claim(session,task);this.assertScreen();await this.tapAt(p.x,p.y);}}
      else if(kind==='swipe'||kind==='drag'){
        const a=this.coordinates(p.x1,p.y1),b=this.coordinates(p.x2,p.y2);const ms=Math.min(Math.max(p.durationMs??350,100),5000);
        await this.video.touch(0,0n,a.x,a.y);try{for(let i=1;i<=20;i++){if(signal?.aborted)throw new ConsoleError('CANCELLED','任务已停止');await pause(ms/20);this.claim(session,task);this.assertScreen();await this.video.touch(2,0n,a.x+(b.x-a.x)*i/20,a.y+(b.y-a.y)*i/20);}}finally{await this.video.touch(1,0n,b.x,b.y);}
      } else if(kind==='pinch'){
        const x=p.x??this.state.width/2,y=p.y??this.state.height/2;const start=p.startDistance??100,end=p.endDistance??400;
        const a=this.coordinates(x-start/2,y),b=this.coordinates(x+start/2,y);await this.video.touch(0,0n,a.x,a.y);await this.video.touch(0,1n,b.x,b.y);
        try{for(let i=1;i<=20;i++){if(signal?.aborted)throw new ConsoleError('CANCELLED','任务已停止');this.claim(session,task);this.assertScreen();const distance=start+(end-start)*i/20;const left=this.coordinates(x-distance/2,y),right=this.coordinates(x+distance/2,y);await this.video.touch(2,0n,left.x,left.y);await this.video.touch(2,1n,right.x,right.y);await pause(20);}}finally{await this.video.release();}
      } else throw new ConsoleError('INVALID_GESTURE','不支持的手势');
      await this.collect();return {status:'ok',snapshotId:this.state.snapshotId};
    },task);
  }
  async stop(){this.stopped=true;clearTimeout(this.summaryTimer);await this.setKeepAwake(false);clearTimeout(this.fullTimer);clearTimeout(this.powerTimer);clearInterval(this.leaseTimer);await this.video.close();this.bridge.close();}
}
