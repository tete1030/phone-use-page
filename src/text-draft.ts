import type {AndroidNode, Observation} from './types.js';

export interface DraftTarget {node:AndroidNode;windowId?:string;source:'focus'|'selected'}
export const writableTextNode=(node:AndroidNode)=>node.editable&&!node.password&&node.enabled&&node.visible;

export function focusedTextNode(state:Observation){
  const fields=state.nodes.filter(n=>writableTextNode(n)&&n.focused);
  return fields.length===1?fields[0]:null;
}

export function currentDraftTarget(state:Observation,selected:DraftTarget|null){
  if(!selected||state.uiError||state.windowId!==selected.windowId)return null;
  const node=state.nodes.find(n=>n.id===selected.node.id),old=selected.node;
  if(!node||!writableTextNode(node)||node.package!==old.package||node.className!==old.className||
     node.resourceId!==old.resourceId||JSON.stringify(node.bounds)!==JSON.stringify(old.bounds))return null;
  if(selected.source==='focus'&&focusedTextNode(state)?.id!==node.id)return null;
  return node;
}

// Only an acknowledged own write may refresh geometry; ordinary observations stay strict.
export function refreshWrittenDraftTarget(state:Observation,selected:DraftTarget,value:string):DraftTarget|null{
  if(state.uiError||state.windowId!==selected.windowId)return null;
  const matches=state.nodes.filter(n=>n.id===selected.node.id),old=selected.node;
  if(matches.length!==1)return null;
  const node=matches[0]!;
  const a=old.bounds,b=node.bounds,overlap=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
  const areas=[(a[2]-a[0])*(a[3]-a[1]),(b[2]-b[0])*(b[3]-b[1])];
  if(!writableTextNode(node)||node.text!==value||node.parentId!==old.parentId||node.package!==old.package||
    node.resourceId!==old.resourceId||!old.resourceId&&node.className!==old.className||Math.min(...areas)<=0||overlap<Math.max(...areas)/2)return null;
  if(selected.source==='focus'&&focusedTextNode(state)?.id!==node.id)return null;
  return {...selected,node:structuredClone(node)};
}
