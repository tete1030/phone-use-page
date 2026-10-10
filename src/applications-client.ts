import {confirmAction} from './confirmation.js';
import type { ApplicationState } from './types.js';

export function installApplications(root:HTMLElement,options:{api:(path:string)=>Promise<any>;perform:(path:string,data:any)=>Promise<any>;canAct:()=>boolean;online:()=>boolean;busyChanged:(busy:boolean)=>void}) {
  const q=<T extends HTMLElement=HTMLElement>(selector:string)=>root.querySelector<T>(selector)!;
  const panel=q('.applications-panel');
  const modes=['tasks','apps','processes'] as const;
  const lists=Object.fromEntries(modes.map(mode=>[mode,q<HTMLUListElement>('.'+mode+'-list')]));
  let state:ApplicationState|null=null,query='',allPackages=false,busy=false,loading=false,error='',timer:ReturnType<typeof setTimeout>|undefined,epoch=0;
  type Row={li:HTMLLIElement;name:HTMLElement;meta:HTMLElement;actions:HTMLElement};
  const columns=new Map(modes.map(mode=>[mode,new Map<string,Row>()]));
  const assign=(element:HTMLElement,value:string)=>{if(element.textContent!==value)element.textContent=value;};
  function controlsChanged(){const blocked=!options.online()||busy||!!error||!options.canAct()||state?.navigation.locked!==false;
    panel.querySelectorAll<HTMLButtonElement>('[data-app-action]').forEach(b=>b.disabled=blocked||b.dataset.available==='false');
    panel.querySelectorAll<HTMLButtonElement>('[data-back-count]').forEach(b=>b.disabled=blocked||!state?.navigation.current);
    q<HTMLButtonElement>('.back-custom').disabled=blocked||!state?.navigation.current;
    q<HTMLButtonElement>('.applications-refresh').disabled=!options.online()||loading||busy;
  }
  async function action(path:string,data:any){if(path.endsWith('/back')&&data.steps>1&&!await confirmAction('连续返回'+data.steps+'次，可能关闭输入法或退出应用，确认？'))return;if(busy||!options.canAct()||error)return;const current=epoch;busy=true;options.busyChanged(true);controlsChanged();
    try{await options.perform(path,data);if(current===epoch)await load();}catch(e){if(options.online()&&current===epoch){error=String(e);assign(q('.applications-status'),error+'；动作未自动重放');}}
    finally{if(current===epoch){busy=false;options.busyChanged(false);controlsChanged();}}
  }
  function render(){if(!state)return;const nav=state.navigation,current=nav.current,task=nav.tasks.find(t=>t.taskId===current?.taskId);
    assign(q('.application-current'),current?`当前任务 #${current.taskId} · ${current.component}`:'当前 Activity 未知');
    assign(q('.activity-stack'),task?.activities.length?task.activities.map(a=>`${a.index}: ${a.component} [${a.state}]`).join(' → '):'系统 Activity 层级未知');
    assign(q('.applications-status'),error||`${new Date(state.collectedAt).toLocaleTimeString()} 更新 · ${nav.locked===true?'手机已锁屏，解锁后可操作':nav.locked===null?'正在确认手机状态':'应用列表自动更新'}`);
    const search=query.trim().toLowerCase(),match=(value:string)=>!search||value.toLowerCase().includes(search);
    for(const mode of modes){
      const list=lists[mode]!,rows=columns.get(mode)!;
      const items:{key:string;name:string;meta:string;actions:{name:string;available:boolean;path:string;data:any}[]}[]=[];
      if(mode==='tasks')for(const t of nav.tasks){if(!match(t.taskId+' '+t.packageName+' '+t.topComponent))continue;
        items.push({key:'task:'+t.userId+':'+t.taskId,name:`#${t.taskId} · ${t.packageName||'未知包'}${t.foreground?' · 前台':''}${t.type==='home'?' · 桌面':''}`,
          meta:`顶部：${t.topComponent||'无 Activity，仅近期记录'} · ${t.activities.length} 个系统 Activity`,
          actions:[{name:`切换任务 #${t.taskId} ${t.packageName}`,available:t.switchable&&!t.foreground,path:'/api/android-tasks/switch',data:{taskId:t.taskId,fingerprint:t.fingerprint}}]});
      }
      else if(mode==='apps')for(const a of state.catalog.apps){if(!allPackages&&!a.launchers.length||!match(a.packageName+' '+a.launchers.join(' ')))continue;
        items.push({key:'app:'+a.packageName,name:a.packageName,meta:`${a.thirdParty?'第三方包':'系统包'} · ${a.launchers.length?a.launchers.length+' 个启动入口':'无桌面启动入口'}`,
          actions:a.launchers.map(component=>({name:`打开 ${a.packageName}${a.launchers.length>1?' '+component.split('/')[1]:''}`,available:true,path:'/api/apps/open',data:{packageName:a.packageName,component}}))});
      }
      else for(const a of state.processes){if(!state.catalog.apps.find(p=>p.packageName===a.packageName)?.launchers.length&&!search)continue;if(!match(a.packageName+' '+a.processes.map(p=>p.name).join(' ')))continue;const tasks=nav.tasks.filter(t=>(t.packageName===a.packageName||t.topComponent?.split('/')[0]===a.packageName)&&t.switchable),app=state.catalog.apps.find(p=>p.packageName===a.packageName);
        items.push({key:'process:'+a.packageName,name:a.packageName,meta:`检测到 ${a.processes.length} 个进程 · PID ${a.processes.map(p=>p.pid).join(',')} · ${tasks.length?'有 '+tasks.length+' 个 UI 任务':'未发现可切换 UI 任务'}`,
          actions:[]});
      }
      const wanted=new Set(items.map(i=>i.key));for(const [key,row]of rows)if(!wanted.has(key)){row.li.remove();rows.delete(key);}
      for(const [index,item]of items.entries()){let row=rows.get(item.key);if(!row){const li=document.createElement('li'),name=document.createElement('span'),meta=document.createElement('span'),actions=document.createElement('div');li.className='application-row';name.className='application-name';meta.className='application-meta';actions.className='application-actions';li.append(name,meta,actions);row={li,name,meta,actions};rows.set(item.key,row);}
        assign(row.name,item.name);assign(row.meta,item.meta);
        const existing=Array.from(row.actions.querySelectorAll<HTMLButtonElement>('button'));
        for(const [j,itemAction]of item.actions.entries()){let button=existing[j];if(!button){button=document.createElement('button');button.type='button';button.dataset.appAction='1';button.addEventListener('click',()=>void action(button!.dataset.path!,JSON.parse(button!.dataset.body!)));row.actions.append(button);}
          const caption=itemAction.path.endsWith('/switch')?'切换 #'+itemAction.data.taskId:item.actions.length>1&&itemAction.data.component?'打开 '+itemAction.data.component.split('/')[1]:'打开';
          assign(button,caption);button.setAttribute('aria-label',itemAction.name);button.dataset.path=itemAction.path;button.dataset.body=JSON.stringify(itemAction.data);button.dataset.available=String(itemAction.available);}
        for(const button of existing.slice(item.actions.length))button.remove();
        if(list.children[index]!==row.li)list.insertBefore(row.li,list.children[index]||null);
      }
      assign(q('.'+mode+'-count'),mode==='apps'?`${items.length} 显示 / ${state.catalog.apps.length} 包`:`${items.length} 条`);
    }
    controlsChanged();
  }
  async function load(refresh=false){if(loading||!options.online())return;const current=epoch;loading=true;controlsChanged();try{const next=await options.api('/api/app-state'+(refresh?'?refreshCatalog=1':''));if(!options.online()||current!==epoch)return;state=next;error='';render();}
    catch(e){if(options.online()&&current===epoch){error=String(e);assign(q('.applications-status'),'应用数据不可用：'+error+'；旧数据保留，动作暂停');}}
    finally{if(current===epoch){loading=false;controlsChanged();}}
  }
  async function poll(){const current=epoch;clearTimeout(timer);if(!options.online())return;await load();if(options.online()&&current===epoch)timer=setTimeout(poll,3500);}
  q('.applications-refresh').addEventListener('click',()=>void load(true));
  q<HTMLInputElement>('.application-search').addEventListener('input',e=>{query=(e.target as HTMLInputElement).value;render();});
  q<HTMLInputElement>('.all-packages').addEventListener('change',e=>{allPackages=(e.target as HTMLInputElement).checked;render();});
  panel.querySelectorAll<HTMLButtonElement>('[data-back-count]').forEach(b=>b.addEventListener('click',()=>void action('/api/navigation/back',{steps:Number(b.dataset.backCount)})));
  q('.back-custom').addEventListener('click',()=>{const input=q<HTMLInputElement>('.back-steps');if(input.reportValidity())void action('/api/navigation/back',{steps:Number(input.value)});});
  return {controlsChanged,pause:()=>{epoch++;loading=false;busy=false;options.busyChanged(false);clearTimeout(timer);controlsChanged();},resume:()=>{epoch++;loading=false;clearTimeout(timer);void poll();}};
}
