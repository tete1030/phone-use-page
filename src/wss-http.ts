import type {FastifyInstance} from 'fastify';
import type {PageConnections,PageConnection} from './page-connections.js';
import type {WebRtcVideo} from './webrtc.js';
import type {Video} from './video.js';
import {z} from 'zod';

export function installWssVideoRoute(app:FastifyInstance,endpoint:(path:string)=>string,options:{
  session:(req:any)=>{owner:string;connection:PageConnection};
  originAllowed:(origin:string|undefined,host:string|undefined)=>boolean;
  pages:Pick<PageConnections,'attach'|'requireOwner'>;
  rtc:Pick<WebRtcVideo,'close'>;
  video:Pick<Video,'view'|'closeViewers'>;
  serialize:<T>(work:()=>Promise<T>)=>Promise<T>;
  parallel?:{registerWss:(owner:string,id:string,parent:AbortSignal,ws:import('ws').WebSocket)=>void};
}){
  app.get(endpoint('/ws/video'),{websocket:true},(ws,req)=>{
    try{
      const s=options.session(req);
      const query=z.object({attemptId:z.string().uuid().optional()}).parse(req.query);
      if(!options.originAllowed(req.headers.origin,req.headers.host))throw new Error('Origin rejected');
      options.pages.attach(s.connection,ws);
      if(options.parallel)options.parallel.registerWss(s.owner,query.attemptId||'legacy-wss',s.connection.abort.signal,ws);
      void options.serialize(async()=>{
        options.pages.requireOwner(s.owner);if(ws.readyState!==1)return;
        if(!options.parallel)await options.rtc.close(s.owner);
        options.pages.requireOwner(s.owner);if(ws.readyState!==1)return;
        options.video.closeViewers();await options.video.view(ws);
      }).catch(()=>{if(ws.readyState===1){ws.send(JSON.stringify({type:'error',message:'手机视频暂不可用'}));ws.close(1011);}});
    }catch{ws.close(1008);}
  });
}
