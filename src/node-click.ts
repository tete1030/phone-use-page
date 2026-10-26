import type {AndroidNode} from './types.js';

export interface ResolvedNodeClick {target:AndroidNode;bounds:AndroidNode['bounds']}
const contains=(outer:AndroidNode['bounds'],inner:AndroidNode['bounds'])=>outer[0]<=inner[0]&&outer[1]<=inner[1]&&outer[2]>=inner[2]&&outer[3]>=inner[3];
const inside=(bounds:AndroidNode['bounds'],x:number,y:number)=>x>=bounds[0]&&y>=bounds[1]&&x<bounds[2]&&y<bounds[3];

export function nodeClickPointClear(node:AndroidNode,nodes:AndroidNode[],x:number,y:number):boolean {
  const byId=new Map(nodes.map(n=>[n.id,n])),chain=new Set<string>();let current:AndroidNode|undefined=node;
  while(current&&!chain.has(current.id)){chain.add(current.id);current=byId.get(current.parentId||'');}
  return !nodes.some(n=>n.visible&&n.enabled&&n.clickable&&!chain.has(n.id)&&inside(n.bounds,x,y));
}

export function resolveNodeClick(node:AndroidNode,nodes:AndroidNode[],width:number,height:number):ResolvedNodeClick|null {
  if(!node.enabled||!node.visible||width<=0||height<=0)return null;
  const bounds:AndroidNode['bounds']=[Math.max(0,node.bounds[0]),Math.max(0,node.bounds[1]),Math.min(width,node.bounds[2]),Math.min(height,node.bounds[3])];
  if(bounds[2]<=bounds[0]||bounds[3]<=bounds[1])return null;
  if(node.clickable)return {target:node,bounds};
  if(node.editable||node.password||(!node.text&&!node.description))return null;
  const byId=new Map(nodes.map(n=>[n.id,n])),chain=new Set([node.id]);
  let parentId=node.parentId;
  while(parentId){
    const parent=byId.get(parentId);
    if(!parent||chain.has(parentId)||parent.package!==node.package||!parent.enabled||!parent.visible||!contains(parent.bounds,node.bounds))return null;
    chain.add(parentId);
    if(parent.clickable){
      // Inheriting a whole-screen container would turn a label into an unrelated action.
      const area=(Math.min(width,parent.bounds[2])-Math.max(0,parent.bounds[0]))*(Math.min(height,parent.bounds[3])-Math.max(0,parent.bounds[1]));
      if(area>width*height*.8)return null;
      const x=(bounds[0]+bounds[2])/2,y=(bounds[1]+bounds[3])/2;
      if(!nodeClickPointClear(node,nodes,x,y))return null;
      return {target:parent,bounds};
    }
    parentId=parent.parentId;
  }
  return null;
}
