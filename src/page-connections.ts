import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { ConsoleError } from './types.js';

interface Page {id:string;sessionId:string;order:number;expires:number}
export type ControlChannel='events'|'control';
export const RECOVERY_GRACE_MS=60000;
export interface PageConnection {page:Page;owner:string;online:boolean;abort:AbortController;sockets:Set<WebSocket>;channels:Map<ControlChannel,WebSocket>;generation:number;recoveringSince:number|null;lastSeen:number;lastActivity:number}

export class PageConnections {
  private pages=new Map<string,Page>();private sequence=0;private latestAutomatic=0;
  active?:PageConnection;
  issue(sessionId:string){const page={id:randomUUID(),sessionId,order:++this.sequence,expires:Date.now()+86400000};this.pages.set(page.id,page);if(this.pages.size>1000)for(const [id,p]of this.pages)if(p.expires<Date.now()&&id!==this.active?.page.id)this.pages.delete(id);return page.id;}
  begin(pageId:string,sessionId:string,explicit=false){
    const page=this.pages.get(pageId);
    if(!page||page.expires<Date.now())throw new ConsoleError('PAGE_EXPIRED','页面已失效，请刷新后连接',401);
    if(page.sessionId!==sessionId)throw new ConsoleError('PAGE_FORBIDDEN','页面不属于当前登录会话',403);
    if(!explicit&&page.order<this.latestAutomatic)throw new ConsoleError('PAGE_OFFLINE','已有后打开的页面连接，本页已离线；可点击重新连接',409);
    if(!explicit)this.latestAutomatic=Math.max(this.latestAutomatic,page.order);
    const previous=this.active;if(previous)this.disconnect(previous,'PAGE_REPLACED');
    const connection={page,owner:randomUUID(),online:false,abort:new AbortController(),sockets:new Set<WebSocket>(),channels:new Map<ControlChannel,WebSocket>(),generation:0,recoveringSince:null,lastSeen:Date.now(),lastActivity:Date.now()};
    this.active=connection;return {connection,previous};
  }
  complete(connection:PageConnection){if(this.active!==connection)throw new ConsoleError('PAGE_OFFLINE','页面连接已被替代',409);connection.online=true;}
  require(pageId:string|undefined,sessionId:string,connectionId:string|undefined,allowRecovery=false){const c=this.active;if(!c||!c.online||c.page.id!==pageId||c.page.sessionId!==sessionId||c.owner!==connectionId)throw new ConsoleError('PAGE_OFFLINE','本页已离线；原连接已失效或已被其他页面接管，自动恢复已停止',409);this.requireOwner(c.owner,allowRecovery);return c;}
  requireOwner(owner:string,allowRecovery=false){if(!this.active?.online||this.active.owner!==owner)throw new ConsoleError('PAGE_OFFLINE','当前页面已离线，后续动作未执行',409);if(!allowRecovery&&this.active.recoveringSince!==null)throw new ConsoleError('CONNECTION_RECOVERING','正在恢复连接，操作未发送',409);}
  attach(connection:PageConnection,ws:WebSocket){this.requireOwner(connection.owner);connection.sockets.add(ws);ws.once('close',()=>connection.sockets.delete(ws));}
  requireGeneration(connection:PageConnection,generation:number){if(generation!==connection.generation)throw new ConsoleError('STALE_TRANSPORT','旧连接请求未重放',409);}
  attachChannel(connection:PageConnection,ws:WebSocket,channel:ControlChannel,generation:number){
    this.requireOwner(connection.owner,true);
    this.requireGeneration(connection,generation);
    const previous=connection.channels.get(channel);connection.channels.set(channel,ws);connection.sockets.add(ws);ws.once('close',()=>connection.sockets.delete(ws));
    if(previous&&previous!==ws)previous.close(4002,'CHANNEL_REPLACED');
    if(['events','control'].every(k=>connection.channels.get(k as ControlChannel)?.readyState===1)){
      connection.recoveringSince=null;connection.lastSeen=Date.now();
      for(const socket of connection.channels.values())socket.send(JSON.stringify({type:'connection-ready',generation:connection.generation}));
    }
  }
  lostChannel(connection:PageConnection,ws:WebSocket,channel:ControlChannel){if(this.active!==connection||!connection.online||connection.channels.get(channel)!==ws)return false;connection.channels.delete(channel);return true;}
  private closeChannels(connection:PageConnection){const sockets=[...connection.channels.values()];connection.channels.clear();for(const ws of sockets)if(ws.readyState===1){try{ws.send(JSON.stringify({type:'recovering',reason:'CONNECTION_RECOVERING'}));}catch{}ws.close(4002,'CONNECTION_RECOVERING');}}
  suspend(connection:PageConnection,now=Date.now()){
    if(this.active!==connection||!connection.online||connection.recoveringSince!==null)return false;
    connection.recoveringSince=now;connection.generation++;this.closeChannels(connection);return true;
  }
  resume(pageId:string,sessionId:string,owner:string,now=Date.now()){
    const c=this.require(pageId,sessionId,owner,true);
    if(this.idle(owner,now))throw new ConsoleError('IDLE_TIMEOUT','5分钟无操作，原会话已结束',409);
    if(c.recoveringSince!==null&&now-c.recoveringSince>=RECOVERY_GRACE_MS)throw new ConsoleError('RECOVERY_TIMEOUT','自动恢复已超时，请手动重新连接',409);
    if(c.recoveringSince===null)throw new ConsoleError('INVALID_RECOVERY','会话尚未进入恢复状态',409);
    c.generation++;this.closeChannels(c);return c;
  }
  heartbeat(owner:string){this.requireOwner(owner,true);this.active!.lastSeen=Date.now();}
  activity(owner:string){this.requireOwner(owner);this.active!.lastActivity=Date.now();}
  idle(owner:string,now=Date.now()){this.requireOwner(owner,true);return now-this.active!.lastActivity>=300000;}
  disconnect(connection:PageConnection,reason='CONNECTION_CLOSED'){
    connection.online=false;connection.abort.abort();
    for(const ws of connection.sockets){if(ws.readyState===1){try{ws.send(JSON.stringify({type:'offline',reason}));}catch{}ws.close(4001,reason);}}
    connection.sockets.clear();connection.channels.clear();if(this.active===connection)this.active=undefined;
  }
}
