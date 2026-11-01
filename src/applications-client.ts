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
  // 应用抽屉：手机导航栏上的入口，只列可启动的应用，点击即打开。
  const drawer=document.querySelector<HTMLElement>('#app-drawer');
  const drawerToggle=document.querySelector<HTMLButtonElement>('.app-drawer-toggle');
  const drawerList=drawer?.querySelector<HTMLUListElement>('.app-drawer-list');
  const drawerFilter=drawer?.querySelector<HTMLInputElement>('.app-drawer-filter');
  const drawerStatus=drawer?.querySelector<HTMLElement>('.app-drawer-status');
  let drawerOpen=false,drawerQuery='',drawerSignature='';
  const assign=(element:HTMLElement,value:string)=>{if(element.textContent!==value)element.textContent=value;};
  function controlsChanged(){const blocked=!options.online()||busy||!!error||!options.canAct()||state?.navigation.locked!==false;
    if(drawerOpen&&drawerList){const drawerBlockedNow=!!drawerBlocked();drawerList.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=drawerBlockedNow);if(drawerStatus&&drawerBlockedNow)drawerStatus.textContent=drawerBlocked();}
    panel.querySelectorAll<HTMLButtonElement>('[data-app-action]').forEach(b=>b.disabled=blocked||b.dataset.available==='false');
    panel.querySelectorAll<HTMLButtonElement>('[data-back-count]').forEach(b=>b.disabled=blocked||!state?.navigation.current);
    q<HTMLButtonElement>('.back-custom').disabled=blocked||!state?.navigation.current;
    q<HTMLButtonElement>('.applications-refresh').disabled=!options.online()||loading||busy;
  }
  async function action(path:string,data:any):Promise<boolean>{if(path.endsWith('/back')&&data.steps>1&&!await confirmAction('连续返回'+data.steps+'次，可能关闭输入法或退出应用，确认？'))return false;if(busy||!options.canAct()||error)return false;const current=epoch;busy=true;options.busyChanged(true);controlsChanged();
    try{await options.perform(path,data);if(current===epoch)await load();return true;}catch(e){if(options.online()&&current===epoch){error=String(e);q('.applications-status').hidden=false;assign(q('.applications-status'),error+'；动作未自动重放');}return false;}
    finally{if(current===epoch){busy=false;options.busyChanged(false);controlsChanged();}}
  }
  const drawerBlocked=()=>!options.online()?'已离线，无法打开应用':busy?'正在执行其他操作…':!options.canAct()?'手机控制暂不可用':'';
  const drawerFingerprint=()=>{const apps=state?.catalog.apps??[];return (state?'1':'0')+'|'+drawerBlocked()+'|'+drawerQuery+'|'+apps.map(a=>a.packageName+'/'+a.launchers.join(',')).join(';');};
  function renderDrawer(){
    if(!drawerOpen||!drawerList)return;
    const apps=state?.catalog.apps??[],search=drawerQuery.trim().toLowerCase(),blocked=drawerBlocked(),items:HTMLLIElement[]=[];
    let shown=0;
    for(const app of apps){
      if(!app.launchers.length)continue;
      if(search&&!`${app.packageName} ${app.launchers.join(' ')}`.toLowerCase().includes(search))continue;
      shown++;
      const li=document.createElement('li');li.className='app-drawer-row';
      const button=document.createElement('button');button.type='button';button.disabled=!!blocked;
      button.dataset.package=app.packageName;button.dataset.component=app.launchers[0];button.setAttribute('aria-label','打开 '+app.packageName);
      const name=document.createElement('span');name.className='app-drawer-name';name.textContent=app.packageName;
      const meta=document.createElement('span');meta.className='app-drawer-meta';meta.textContent=(app.thirdParty?'第三方':'系统')+' · '+app.launchers.length+' 个启动入口';
      const open=document.createElement('span');open.className='app-drawer-open';open.textContent='打开';
      button.append(name,meta,open);li.append(button);items.push(li);
    }
    drawerList.replaceChildren(...items);
    if(drawerStatus){const status=blocked||(!state?'正在读取应用列表…':shown?shown+' 个可启动应用'+(search?'（已筛选）':''):apps.length?'没有匹配的应用':'没有可启动的应用');if(drawerStatus.textContent!==status)drawerStatus.textContent=status;}
    drawerSignature=drawerFingerprint();
  }
  function renderDrawerIfChanged(){if(drawerOpen&&drawerFingerprint()!==drawerSignature)renderDrawer();}
  function openDrawer(){if(drawerOpen||!drawer)return;drawerOpen=true;drawer.hidden=false;drawerToggle?.setAttribute('aria-expanded','true');drawerSignature='';drawerQuery='';if(drawerFilter)drawerFilter.value='';renderDrawer();if(!state)void load();drawerFilter?.focus();}
  function closeDrawer(){if(!drawerOpen||!drawer)return;drawerOpen=false;drawer.hidden=true;drawerToggle?.setAttribute('aria-expanded','false');drawerSignature='';drawerToggle?.focus();}
  async function openFromDrawer(button:HTMLButtonElement){const packageName=button.dataset.package!,component=button.dataset.component!;if(await action('/api/apps/open',{packageName,component}))closeDrawer();}

  function render(){if(!state)return;const nav=state.navigation,current=nav.current,task=nav.tasks.find(t=>t.taskId===current?.taskId);
    assign(q('.application-current'),current?`当前任务 #${current.taskId} · ${current.component}`:'当前 Activity 未知');
    assign(q('.activity-stack'),task?.activities.length?task.activities.map(a=>`${a.index}: ${a.component} [${a.state}]`).join(' → '):'系统 Activity 层级未知');
    assign(q('.applications-status'),error);q('.applications-status').hidden=!error;
    const search=query.trim().toLowerCase(),match=(value:string)=>!search||value.toLowerCase().includes(search);
    for(const mode of modes){
      const list=lists[mode]!,rows=columns.get(mode)!;
      const items:{key:string;name:string;meta:string;actions:{name:string;available:boolean;path:string;data:any;reason?:string}[]}[]=[];
      if(mode==='tasks')for(const t of nav.tasks){if(!match(t.taskId+' '+t.packageName+' '+t.topComponent))continue;
        items.push({key:'task:'+t.userId+':'+t.taskId,name:`#${t.taskId} · ${t.packageName||'未知包'}${t.foreground?' · 前台':''}${t.type==='home'?' · 桌面':''}`,
          meta:`顶部：${t.topComponent||'无 Activity，仅近期记录'} · ${t.activities.length} 个系统 Activity${t.foreground?' · 已在前台，无需切换':!t.switchable?' · 该任务不可切换':''}`,
          actions:[{name:`切换任务 #${t.taskId} ${t.packageName}`,available:t.switchable&&!t.foreground,path:'/api/android-tasks/switch',data:{taskId:t.taskId,fingerprint:t.fingerprint},reason:t.foreground?'已是前台，无需切换':!t.switchable?'该任务当前不可切换':''}]});
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
          assign(button,caption);button.setAttribute('aria-label',itemAction.name);button.title=itemAction.available?'':itemAction.reason||'当前不可用';button.dataset.path=itemAction.path;button.dataset.body=JSON.stringify(itemAction.data);button.dataset.available=String(itemAction.available);}
        for(const button of existing.slice(item.actions.length))button.remove();
        if(list.children[index]!==row.li)list.insertBefore(row.li,list.children[index]||null);
      }
      assign(q('.'+mode+'-count'),mode==='apps'?`${items.length} 显示 / ${state.catalog.apps.length} 包`:`${items.length} 条`);
    }
    // 面板收起时，标题行仍显示规模，避免“看不见就当没有”。
    assign(q('.applications-summary'),`应用 ${state.catalog.apps.length} · 任务 ${state.navigation.tasks.length} · 进程 ${state.processes.length}`);
    controlsChanged();renderDrawerIfChanged();
  }
  async function load(refresh=false){if(loading||!options.online())return;const current=epoch;loading=true;controlsChanged();try{const next=await options.api('/api/app-state'+(refresh?'?refreshCatalog=1':''));if(!options.online()||current!==epoch)return;state=next;error='';render();}
    catch(e){if(options.online()&&current===epoch){error=String(e);q('.applications-status').hidden=false;assign(q('.applications-status'),'应用数据不可用：'+error+'；旧数据保留，动作暂停');assign(q('.applications-summary'),'应用数据不可用');}}
    finally{if(current===epoch){loading=false;controlsChanged();}}
  }
  async function poll(){const current=epoch;clearTimeout(timer);if(!options.online())return;await load();if(options.online()&&current===epoch)timer=setTimeout(poll,3500);}
  q('.applications-refresh').addEventListener('click',()=>void load(true));
  q<HTMLInputElement>('.application-search').addEventListener('input',e=>{query=(e.target as HTMLInputElement).value;render();});
  q<HTMLInputElement>('.all-packages').addEventListener('change',e=>{allPackages=(e.target as HTMLInputElement).checked;render();});
  panel.querySelectorAll<HTMLButtonElement>('[data-back-count]').forEach(b=>b.addEventListener('click',()=>void action('/api/navigation/back',{steps:Number(b.dataset.backCount)})));
  q('.back-custom').addEventListener('click',()=>{const input=q<HTMLInputElement>('.back-steps');if(input.reportValidity())void action('/api/navigation/back',{steps:Number(input.value)});});
  drawerToggle?.addEventListener('click',()=>drawerOpen?closeDrawer():openDrawer());
  drawer?.querySelector('.app-drawer-close')?.addEventListener('click',()=>closeDrawer());
  drawer?.addEventListener('click',event=>{if(event.target===drawer)closeDrawer();});
  drawer?.addEventListener('keydown',event=>{if((event as KeyboardEvent).key==='Escape'){event.preventDefault();event.stopPropagation();closeDrawer();}});
  drawerFilter?.addEventListener('input',()=>{drawerQuery=drawerFilter.value;renderDrawer();});
  drawerList?.addEventListener('click',event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button[data-package]');if(button&&!button.disabled)void openFromDrawer(button);});
  return {controlsChanged,pause:()=>{epoch++;loading=false;busy=false;options.busyChanged(false);clearTimeout(timer);controlsChanged();},resume:()=>{epoch++;loading=false;clearTimeout(timer);void poll();}};
}
