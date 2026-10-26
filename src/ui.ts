import { readFile } from 'node:fs/promises';
import type { Observation,AndroidNode } from './types.js';
import {escape,label,nodeValue,shortId,shownNodes} from './presentation.js';
let template: string;
export async function readAssetVersion(){
  const value=JSON.parse(await readFile('dist/web/assets.json','utf8'));
  if(typeof value.version!=='string'||!/^[a-f0-9]{16}$/.test(value.version))throw new Error('Invalid web asset version');
  return value.version as string;
}
function treeHTML(nodes:AndroidNode[]) {
  const display=shownNodes(nodes,'compact','');const visible=new Set(display.map(n=>n.id));const children=new Map<string|null,AndroidNode[]>();
  for(const n of display){let p=n.parentId;if(p&&!visible.has(p))p=null;const list=children.get(p)||[];list.push(n);children.set(p,list);}
  const rows=(parent:string|null):string=>(children.get(parent)||[]).map(n=>`<li data-node-id="${escape(n.id)}"><button type="button" class="node-button" data-node-id="${escape(n.id)}"><span class="node-code">${shortId(n,nodes)} </span><span class="node-branch" aria-hidden="true" style="margin-left:${Math.min(n.depth,8)*10}px">↳</span><span class="node-label">${escape(label(n,nodes))}</span><span class="node-value"> ${escape(nodeValue(n))}</span></button>${children.has(n.id)?'<ul>'+rows(n.id)+'</ul>':''}</li>`).join('');
  return rows(null);
}
export async function render(state:Observation,boot:any) {
  template??=await readFile('web/template.html','utf8');const last=boot.tasks[0];
  const values:Record<string,string>={BASE:escape(boot.basePath||'/'),MODEL:escape(state.model||'Android'),CONNECTION:state.connected?'ADB 已连接':'连接设备中',SYSTEM:escape(state.system||state.android||''),APP:escape(state.foregroundApp),FOCUS:escape(state.focus?.text||state.focus?.resourceId||'无可读输入框'),SIZE:`${state.width} × ${state.height}`,SNAPSHOT:escape(state.snapshotId||'尚未采集'),COUNT:shownNodes(state.nodes,'compact','').length+' 条节点',NODES:treeHTML(state.nodes),UI_STATUS:escape(state.uiError||'UI 已采集'),SDK:escape(boot.sdk),RESULT_STATUS:last?escape(last.status):'就绪',RESULTS:'<div class="log-message">等待动作结果</div>',SERIAL:escape(state.serial),BOOTSTRAP:JSON.stringify({...boot,state}).replaceAll('<','\u003c')};
  const suffix=boot.assetVersion?'?v='+encodeURIComponent(boot.assetVersion):'';
  values.CLIENT_ASSET=escape((boot.basePath||'/')+'assets/client.js'+suffix);values.STYLE_ASSET=escape((boot.basePath||'/')+'assets/style.css'+suffix);
  return template.replace(/\{\{([A-Z_]+)\}\}/g,(_,key)=>values[key]??'');
}
