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
