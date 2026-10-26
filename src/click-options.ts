import {ConsoleError, type AndroidNode} from './types.js';
import type {Realism} from './gesture-plan.js';

export interface ClickOptions {jitter?:boolean;realism?:Realism}
export interface ResolvedClickOptions {jitter:boolean;realism:Realism}
const REALISM:Realism[]=['auto','off','framework','client'];

export function resolveClickOptions(value:unknown,defaults:ResolvedClickOptions={jitter:true,realism:'auto'}):ResolvedClickOptions {
  if(value===undefined)return {...defaults};
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ConsoleError('INVALID_CLICK_OPTIONS','点击选项必须是对象');
  const p=value as Record<string,unknown>;
  if(Object.keys(p).some(k=>k!=='jitter'&&k!=='realism')
    ||p.jitter!==undefined&&typeof p.jitter!=='boolean'
    ||p.realism!==undefined&&!REALISM.includes(p.realism as Realism))
    throw new ConsoleError('INVALID_CLICK_OPTIONS','点击选项仅支持 jitter: boolean 与 realism: auto|off|framework|client');
  return {jitter:p.jitter as boolean??defaults.jitter,realism:(p.realism as Realism|undefined)??defaults.realism};
}

export function nodeTouchPoint(n:AndroidNode,width:number,height:number,jitter:boolean,random= Math.random) {
  const [l,t,r,b]=n.bounds,left=Math.max(0,Math.ceil(l)),top=Math.max(0,Math.ceil(t)),right=Math.min(width,Math.ceil(r))-1,bottom=Math.min(height,Math.ceil(b))-1;
  if(!Number.isInteger(width)||!Number.isInteger(height)||![left,top,right,bottom].every(Number.isFinite)||left>right||top>bottom)throw new ConsoleError('UNAVAILABLE_TARGET','目标没有有效的屏幕内触摸区域',409);
  const x=Math.min(right,Math.floor((left+right+1)/2)),y=Math.min(bottom,Math.floor((top+bottom+1)/2));
  if(!jitter)return {x,y};
  // Stay close to the center; narrow controls keep a fixed coordinate.
  const dx=Math.min(5,Math.floor((right-left+1)/10)),dy=Math.min(5,Math.floor((bottom-top+1)/10));
  const offset=(radius:number)=>Math.floor(random()*(radius*2+1))-radius;
  return {x:Math.max(left,Math.min(right,x+offset(dx))),y:Math.max(top,Math.min(bottom,y+offset(dy)))};
}
