import type { AndroidNode } from './types.js';
export function label(n:AndroidNode,nodes:AndroidNode[]) {
  if(n.editable)return n.description||n.resourceId.split('/').pop()||'文本输入框';
  if(n.text||n.description)return n.text||n.description;
  if(n.clickable){const child=nodes.find(x=>x.parentId===n.id&&x.text&&!x.checkable);if(child)return child.text;}
  return n.resourceId.split('/').pop()||n.className.split('.').pop()||'未命名节点';
}
export function shortId(n:AndroidNode,nodes:AndroidNode[]) {let length=6;while(length<16&&nodes.some(x=>x.id!==n.id&&x.id.startsWith(n.id.slice(0,length))))length++;return 'n'+n.id.slice(0,length);}
export function nodeValue(n:AndroidNode){return [n.password?'密码（不回读）':'',n.checkable?(n.checked?'开启':'关闭'):'',!n.enabled?'不可用':'',n.editable?'可编辑':'',n.editable&&!n.password&&n.text?'文本：'+n.text:'',n.focused?'手机焦点':'',n.scrollable?'可滚动':''].filter(Boolean).join(' · ');}
export function taskResultPreview(value:unknown){
  if(value==null)return '';
  if(typeof value==='object'&&!Array.isArray(value)){
    const result=value as Record<string,unknown>;
    if(Array.isArray(result.nodes))return '';
    if(result.execution==='sent'&&['verified','not_verified','failed','inconclusive'].includes(String(result.verification)))return JSON.stringify({execution:result.execution,verification:result.verification});
  }
  const text=JSON.stringify(value);return text&&text.length<=160?text:'';
}
export function shownNodes(nodes:AndroidNode[],mode:string,query:string) {
  const byId=new Map(nodes.map(n=>[n.id,n]));
  let base=nodes;
  if(mode==='compact')base=nodes.filter(n=>{
    const parent=byId.get(n.parentId||'');const actionable=n.clickable||n.editable||n.checkable||n.longClickable||n.scrollable;
    if(!actionable&&!n.text&&!n.description)return false;
    if(!actionable&&parent?.clickable&&label(parent,nodes)===n.text)return false;
    return true;
  });
  if(mode==='actionable')base=nodes.filter(n=>n.clickable||n.editable||n.checkable||n.longClickable||n.scrollable);
  if(query.trim()){const text=query.trim().toLowerCase();base=nodes.filter(n=>[n.id,'n'+n.id,n.text,n.description,n.resourceId,n.className,n.package,label(n,nodes),nodeValue(n)].join(' ').toLowerCase().includes(text));}
  // Retain a minimal ancestor chain so filtered nodes do not acquire false parents.
  const include=new Set(base.map(n=>n.id));for(const n of base){let p=n.parentId;while(p&&byId.has(p)){include.add(p);p=byId.get(p)!.parentId;}}
  return nodes.filter(n=>include.has(n.id));
}
export function escape(value:unknown){return String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');}
