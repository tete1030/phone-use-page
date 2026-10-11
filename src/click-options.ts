import {ConsoleError, type AndroidNode} from './types.js';

export interface ClickOptions {jitter?:boolean}
export interface ResolvedClickOptions {jitter:boolean}

export function resolveClickOptions(value:unknown,defaults:ResolvedClickOptions={jitter:true}):ResolvedClickOptions {
  if(value===undefined)return {...defaults};
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ConsoleError('INVALID_CLICK_OPTIONS','点击选项必须是对象');
  const p=value as Record<string,unknown>;
  if(Object.keys(p).some(k=>k!=='jitter')||p.jitter!==undefined&&typeof p.jitter!=='boolean')throw new ConsoleError('INVALID_CLICK_OPTIONS','点击选项仅支持 jitter: boolean');
  return {jitter:p.jitter as boolean??defaults.jitter};
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
