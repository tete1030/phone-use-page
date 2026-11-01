import type { AndroidNode, Observation } from './types.js';
import { label, shortId } from './presentation.js';
import { resolveNodeClick } from './node-click.js';

// Agent-facing projections of the observation. The full tree is right for the
// element viewer; text and LLM agents pay for every node they read. These
// shapes keep only what an action needs: how to find the row, whether it can
// be acted on, and where it is on screen.
export type ObservationView='full'|'compact'|'actionable';
export const observationViews:ObservationView[]=['full','compact','actionable'];

export function observationView(value:unknown,fallback:ObservationView='actionable'):ObservationView {
  return typeof value==='string'&&(observationViews as string[]).includes(value)?value as ObservationView:fallback;
}

export interface ObservationRow {
  id:string;
  label:string;
  bounds:[number,number,number,number];
  text?:string;
  description?:string;
  resourceId?:string;
  className?:string;
  package?:string;
  clickable?:true;
  /** Ancestor that would receive the click when the row itself is not clickable. */
  clickTarget?:string;
  editable?:true;
  password?:true;
  checked?:boolean;
  disabled?:true;
  longClickable?:true;
  scrollable?:true;
  focused?:true;
}

export interface ProjectedObservation {
  view:Exclude<ObservationView,'full'>;
  snapshotId:string;
  captureSeq?:number;
  collectedAt:number;
  ageMs:number;
  width:number;
  height:number;
  rotation:number;
  screenOn:boolean;
  locked?:boolean|null;
  windowId?:string;
  foregroundApp:string;
  focus:{id:string;label:string}|null;
  totalNodes:number;
  rows:ObservationRow[];
  uiError?:string;
}

const actionable=(n:AndroidNode)=>n.clickable||n.editable||n.checkable||n.longClickable||n.scrollable;

function wanted(nodes:AndroidNode[],view:Exclude<ObservationView,'full'>):AndroidNode[] {
  const byId=new Map(nodes.map(n=>[n.id,n]));
  return nodes.filter(n=>{
    if(!n.visible)return false;
    if(actionable(n))return true;
    if(view==='actionable')return false;
    if(!n.text&&!n.description)return false;
    // A label that only repeats its clickable parent is already on the parent row.
    const parent=byId.get(n.parentId||'');
    return !(parent?.clickable&&label(parent,nodes)===label(n,nodes));
  });
}

function row(n:AndroidNode,nodes:AndroidNode[],width:number,height:number):ObservationRow {
  const out:ObservationRow={id:shortId(n,nodes),label:label(n,nodes),bounds:n.bounds};
  if(n.text&&n.text!==out.label)out.text=n.text;
  if(n.description&&n.description!==out.label)out.description=n.description;
  if(n.resourceId)out.resourceId=n.resourceId;
  if(n.className)out.className=n.className;
  if(n.package)out.package=n.package;
  if(n.clickable)out.clickable=true;
  else if(n.enabled){
    const resolved=resolveNodeClick(n,nodes,width,height);
    if(resolved&&resolved.target.id!==n.id)out.clickTarget=shortId(resolved.target,nodes);
  }
  if(n.editable)out.editable=true;
  if(n.password)out.password=true;
  if(n.checkable)out.checked=n.checked;
  if(!n.enabled)out.disabled=true;
  if(n.longClickable)out.longClickable=true;
  if(n.scrollable)out.scrollable=true;
  if(n.focused)out.focused=true;
  return out;
}

export function projectObservation(state:Observation,view:Exclude<ObservationView,'full'>='actionable',now=Date.now()):ProjectedObservation {
  const rows=wanted(state.nodes,view).map(n=>row(n,state.nodes,state.width,state.height));
  const focus=state.focus?{id:shortId(state.focus,state.nodes),label:label(state.focus,state.nodes)}:null;
  const projected:ProjectedObservation={
    view,snapshotId:state.snapshotId,captureSeq:state.captureSeq,collectedAt:state.collectedAt,
    ageMs:state.collectedAt?now-state.collectedAt:0,width:state.width,height:state.height,rotation:state.rotation,
    screenOn:state.screenOn,locked:state.locked,windowId:state.windowId,foregroundApp:state.foregroundApp,
    focus,totalNodes:state.nodes.length,rows
  };
  if(state.uiError)projected.uiError=state.uiError;
  return projected;
}

const ago=(ms:number)=>ms<1000?'刚刚':(ms/1000).toFixed(1)+' 秒前';
const shortRid=(n:ObservationRow,foregroundApp:string)=>{
  const rid=n.resourceId||'';
  if(foregroundApp&&rid.startsWith(foregroundApp+':id/'))return rid.slice(foregroundApp.length+1);
  return rid;
};
export function rowText(n:ObservationRow,foregroundApp=''):string {
  const flags:string[]=[];
  if(n.disabled)flags.push('不可用');
  if(n.password)flags.push('密码（不回读）');
  else if(n.checked!==undefined)flags.push(n.checked?'开关：开':'开关：关');
  else if(n.editable)flags.push('可编辑');
  if(n.text&&n.text!==n.label&&!n.password)flags.push('文本：'+n.text);
  if(n.clickable)flags.push('可点击');
  else if(n.clickTarget)flags.push('点击→'+n.clickTarget);
  else if(n.label&&!n.editable)flags.push('不可点击');
  if(n.longClickable)flags.push('可长按');
  if(n.scrollable)flags.push('可滚动');
  if(n.focused)flags.push('焦点');
  const rid=shortRid(n,foregroundApp);
  return [n.id,n.label,...flags,`[${n.bounds[0]},${n.bounds[1]}→${n.bounds[2]},${n.bounds[3]}]`,rid].filter(Boolean).join(' · ');
}

export function renderObservationText(p:ProjectedObservation,now=Date.now()):string {
  const lines:string[]=[];
  lines.push(`安卓观察 · ${p.width}×${p.height} · 旋转 ${p.rotation}° · ${p.screenOn?'屏幕开':'屏幕关'} · ${p.locked===false?'未锁屏':p.locked?'已锁屏':'锁屏状态未知'}`);
  const viewLabel=p.view==='actionable'?'可操作':'精简';
  const stale=now-p.collectedAt>15000?' · 已过期，请刷新':'';
  lines.push(`快照 ${p.snapshotId||'无'} · ${ago(now-p.collectedAt)} · 前台 ${p.foregroundApp||'未知'} · ${p.rows.length}/${p.totalNodes} 行（${viewLabel}）${stale}`);
  lines.push(p.focus?`焦点 ${p.focus.id} ${p.focus.label}`:'焦点 无（手机输入框未获得焦点）');
  if(p.uiError)lines.push('采集错误：'+p.uiError);
  lines.push('');
  lines.push(...p.rows.map(n=>rowText(n,p.foregroundApp)));
  return lines.join('\n');
}
