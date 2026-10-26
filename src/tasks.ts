import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Device, keyCodes } from './device.js';
import { ConsoleError, type Selector } from './types.js';
import {resolveClickOptions,type ClickOptions,type ResolvedClickOptions} from './click-options.js';

export interface Task {id:string;status:string;startedAt:number;finishedAt?:number;logs:string[];steps:number;result?:unknown;error?:string;owner:string;code:string;clickOptions?:ResolvedClickOptions}
const wait=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{if(signal.aborted){reject(new ConsoleError('CANCELLED','任务已停止'));return;}const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);const abort=()=>{clearTimeout(timer);reject(new ConsoleError('CANCELLED','任务已停止'));};signal.addEventListener('abort',abort,{once:true});});

export class Tasks extends EventEmitter {
  onActivity:(owner:string)=>void=()=>{};
  records=new Map<string,Task>();private children=new Map<string,ChildProcess>();private signals=new Map<string,AbortController>();private saves=new Map<string,Promise<void>>();
  constructor(private device:Device){super();}
  async init(){await mkdir('.local/tasks',{recursive:true,mode:0o700});for(const name of await readdir('.local/tasks')){if(!/^[a-f0-9-]+\.json$/.test(name))continue;try{const t=JSON.parse(await readFile('.local/tasks/'+name,'utf8')) as Task;if(t.status==='running'){t.status='interrupted';t.error='服务已重启，未重放任何设备动作';}this.records.set(t.id,t);}catch{}}}
  private save(task:Task){
    this.emit('task',task);const data=JSON.stringify(task),path='.local/tasks/'+task.id+'.json';
    const work=(this.saves.get(task.id)||Promise.resolve()).catch(()=>{}).then(async()=>{await writeFile(path+'.tmp',data,{mode:0o600});await rename(path+'.tmp',path);});
    this.saves.set(task.id,work);void work.finally(()=>{if(this.saves.get(task.id)===work)this.saves.delete(task.id);}).catch(error=>console.error('Task persistence:',String(error)));
  }
  latest(){return [...this.records.values()].sort((a,b)=>b.startedAt-a.startedAt).slice(0,20);}
  async start(code:string,owner:string,check=false,clickOptions?:ClickOptions){
    if(typeof code!=='string'||!code.trim()||code.length>32768)throw new ConsoleError('SCRIPT_LIMIT','脚本不能为空，且不能超过 32768 字符');
    const task:Task={id:randomUUID(),status:'running',startedAt:Date.now(),logs:[],steps:0,owner,code,clickOptions:resolveClickOptions(clickOptions)};
    if(!check){this.device.claim(owner);if(this.device.activeTask)throw new ConsoleError('TASK_BUSY','已有脚本运行',409);this.device.activeTask=task.id;this.device.publish();try{await this.device.video.release();this.device.claim(owner,task.id);}catch(error){if(this.device.activeTask===task.id)this.device.activeTask=undefined;this.device.publish();throw error;}}
    const controller=new AbortController();this.signals.set(task.id,controller);this.records.set(task.id,task);
    const child=fork(resolve('dist/script-worker.js'),[],{cwd:process.cwd(),env:{PATH:process.env.PATH},execArgv:['--max-old-space-size=128'],stdio:['ignore','ignore','pipe','ipc']});this.children.set(task.id,child);
    const wall=setTimeout(()=>this.finish(task,'timeout','任务超过 60 秒时限'),60000);
    child.stderr?.on('data',()=>{});
    child.on('message',async(message:any)=>{
      if(task.status!=='running')return;
      if(message.type==='ready'){child.send({type:'run',code,check});return;}
      if(message.type==='rpc'){
        if(check){child.send({type:'reply',id:message.id,ok:false,error:'Syntax checking cannot call device SDK'});return;}
        if(++task.steps>200){this.finish(task,'failed','SDK 调用超过 200 次');return;}
        this.save(task);
        try{const params=JSON.parse(message.params);const result=await this.rpc(message.method,params,owner,task.id,controller.signal,task.clickOptions);if(task.status==='running'&&child.connected)child.send({type:'reply',id:message.id,ok:true,result});}
        catch(error){if(child.connected)child.send({type:'reply',id:message.id,ok:false,code:error instanceof ConsoleError?error.code:'DEVICE_ERROR',error:error instanceof Error?error.message:String(error),...(error instanceof ConsoleError?{execution:error.execution,verification:error.verification}:{})});}
        this.save(task);
      }else if(message.type==='log'){if(task.logs.join('').length+message.text.length>65536){this.finish(task,'failed','日志超过 64 KiB');return;}task.logs.push(message.text);this.save(task);}
      else if(message.type==='done'){task.result=message.result;this.finish(task,'completed');}
      else if(message.type==='failed')this.finish(task,'failed',message.error);
    });
    child.once('exit',()=>{clearTimeout(wall);if(task.status==='running')this.finish(task,'failed','脚本进程退出');});
    child.once('error',error=>this.finish(task,'failed',error.message));
    this.save(task);return task;
  }
  private finish(task:Task,status:string,error?:string){if(task.status!=='running')return;task.status=status;task.error=error;task.finishedAt=Date.now();this.signals.get(task.id)?.abort();this.children.get(task.id)?.kill();this.children.delete(task.id);this.signals.delete(task.id);if(this.device.activeTask===task.id){void this.device.resetControl().catch(()=>{});this.device.activeTask=undefined;this.device.publish();}this.save(task);}
  stop(id:string,owner:string){const task=this.records.get(id);if(!task)throw new ConsoleError('TASK_NOT_FOUND','任务不存在',404);if(task.owner!==owner)throw new ConsoleError('FORBIDDEN','不能停止其他会话任务',403);this.finish(task,'cancelled','用户停止；已完成动作不回滚');return task;}
  revokeOwner(owner:string,message='页面已离线，后续动作已停止；已完成动作保留'){let count=0;for(const task of this.records.values())if(task.owner===owner&&task.status==='running'){this.finish(task,'cancelled',message);count++;}return count;}
  private async rpc(method:string,p:any,owner:string,taskId:string,signal:AbortSignal,clickOptions:ResolvedClickOptions={jitter:true}):Promise<unknown>{
    if(signal.aborted)throw new ConsoleError('CANCELLED','任务已停止');this.onActivity(owner);
    if(method==='panel'){if(!['notifications','settings'].includes(p.kind))throw new ConsoleError('INVALID_PANEL','无效面板');return this.device.panel(owner,p.kind,taskId);}
    if(method==='clipboard'){if(p.write&&(typeof p.text!=='string'||p.text.length>32768))throw new ConsoleError('TEXT_LIMIT','剪贴板文字无效');return this.device.enqueue(owner,async()=>{await this.device.ensureInteractive();return this.device.bridge.call('clipboard',p);},taskId);}
    if(method==='observe')return this.device.collect({fresh:true});
    if(method==='uiTree')return (await this.device.collect({fresh:true})).nodes;
    if(method==='screenshot')return this.device.bridge.call('screenshot');
    if(method==='sleep'){if(!Number.isFinite(p.ms)||p.ms<0||p.ms>30000)throw new ConsoleError('INVALID_WAIT','等待时间必须在 0–30000 ms');await wait(p.ms,signal);return null;}
    if(method==='node'){const options=resolveClickOptions(p.clickOptions,clickOptions);return this.device.nodeAction(owner,null,p.action,p.value,taskId,options,p.selector);}
    if(method==='press'){const code=keyCodes[p.key];if(code===undefined)throw new ConsoleError('INVALID_KEY','不支持的按键名');return this.device.press(owner,code,0,taskId);}
    if(method==='gesture')return this.device.gesture(owner,p.kind,p,taskId,signal);
    if(method==='apps'){const state=await this.device.appState(!!p.refresh);return state.catalog.apps.filter(a=>!p.launchableOnly||a.launchers.length);}
    if(method==='recentTasks')return (await this.device.navigation()).tasks;
    if(method==='navigation')return this.device.navigation();
    if(method==='runningApps'){const state=await this.device.appState();return {userId:state.catalog.userId,collectedAt:state.collectedAt,processScope:state.processScope,apps:state.processes};}
    if(method==='switchTask')return this.device.switchTask(owner,p.taskId,undefined,taskId);
    if(method==='back')return this.device.back(owner,p,taskId,signal);
    if(method==='openApp')return this.device.openApp(owner,p.packageName,p.component,taskId);
    if(method==='waitFor'||method==='waitGone'){
      const ms=p.timeoutMs??5000;if(!Number.isFinite(ms)||ms<0||ms>30000)throw new ConsoleError('INVALID_WAIT','超时必须在 0–30000 ms');const end=Date.now()+ms;
      do{await this.device.collect();try{const n=this.device.find(p.selector);if(method==='waitFor'&&n.visible)return n;}catch(error){if(error instanceof ConsoleError&&error.code==='TARGET_NOT_FOUND'){if(method==='waitGone')return null;}else throw error;}await wait(200,signal);}while(Date.now()<end);
      throw new ConsoleError('TIMEOUT','等待界面条件超时');
    }
    if(method==='scrollIntoView'){for(let i=0;i<8;i++){await this.device.collect();try{const n=this.device.find(p.selector);if(n.visible)return n;}catch(error){if(!(error instanceof ConsoleError)||error.code!=='TARGET_NOT_FOUND')throw error;}const s=this.device.state;await this.device.gesture(owner,'swipe',{x1:s.width/2,y1:s.height*.75,x2:s.width/2,y2:s.height*.3},taskId,signal);}throw new ConsoleError('TARGET_NOT_FOUND','8 次滑动后仍未找到目标');}
    throw new ConsoleError('UNSUPPORTED_API','不支持的 SDK 方法');
  }
  async close(){for(const task of this.records.values())if(task.status==='running')this.finish(task,'interrupted','服务关闭，任务未重放');await Promise.allSettled(this.saves.values());}
}
