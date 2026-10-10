import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { ConsoleError } from './types.js';

interface Page {id:string;sessionId:string;order:number;expires:number}
export interface PageConnection {page:Page;owner:string;online:boolean;abort:AbortController;sockets:Set<WebSocket>;lastSeen:number;lastActivity:number}

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
    const connection={page,owner:randomUUID(),online:false,abort:new AbortController(),sockets:new Set<WebSocket>(),lastSeen:Date.now(),lastActivity:Date.now()};
    this.active=connection;return {connection,previous};
  }
  complete(connection:PageConnection){if(this.active!==connection)throw new ConsoleError('PAGE_OFFLINE','页面连接已被替代',409);connection.online=true;}
  require(pageId:string|undefined,sessionId:string,connectionId:string|undefined){const c=this.active;if(!c||!c.online||c.page.id!==pageId||c.page.sessionId!==sessionId||c.owner!==connectionId)throw new ConsoleError('PAGE_OFFLINE','本页已离线，点击重新连接或刷新页面',409);return c;}
  requireOwner(owner:string){if(!this.active?.online||this.active.owner!==owner)throw new ConsoleError('PAGE_OFFLINE','当前页面已离线，后续动作未执行',409);}
  attach(connection:PageConnection,ws:WebSocket){this.requireOwner(connection.owner);connection.sockets.add(ws);ws.once('close',()=>connection.sockets.delete(ws));}
  heartbeat(owner:string){this.requireOwner(owner);this.active!.lastSeen=Date.now();}
  activity(owner:string){this.requireOwner(owner);this.active!.lastActivity=Date.now();}
  idle(owner:string,now=Date.now()){this.requireOwner(owner);return now-this.active!.lastActivity>=300000;}
  disconnect(connection:PageConnection,reason='CONNECTION_CLOSED'){
    connection.online=false;connection.abort.abort();
    for(const ws of connection.sockets){if(ws.readyState===1){try{ws.send(JSON.stringify({type:'offline',reason}));}catch{}ws.close(4001,reason);}}
    connection.sockets.clear();if(this.active===connection)this.active=undefined;
  }
}
