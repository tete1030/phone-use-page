import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {WebRtcVideo} from './webrtc.js';

interface RtcRoutes {prepare:(owner:string,signal:AbortSignal,provider?:'none'|'coturn'|'cloudflare',attemptId?:string)=>Promise<any>;offer:(owner:string,sdp:string,signal:AbortSignal,configId?:string,attemptId?:string)=>Promise<any>;diagnostics:(owner:string)=>Promise<any>}
export function installWebRtcRoutes(app:FastifyInstance,endpoint:(path:string)=>string,session:(req:any,mutating?:boolean)=>{owner:string;connection:{abort:AbortController}},rtc:RtcRoutes){
  app.post(endpoint('/api/webrtc/config'),async req=>{const s=session(req,true);const p=z.object({provider:z.enum(['none','coturn','cloudflare']).optional(),attemptId:z.string().uuid().optional()}).strict().parse(req.body);return rtc.prepare(s.owner,s.connection.abort.signal,p.provider,p.attemptId);});
  app.post(endpoint('/api/webrtc/offer'),async req=>{const s=session(req,true);const p=z.object({type:z.literal('offer'),sdp:z.string().min(100).max(65536),configId:z.string().max(64).optional(),attemptId:z.string().uuid().optional()}).parse(req.body);return rtc.offer(s.owner,p.sdp,s.connection.abort.signal,p.configId,p.attemptId);});
  app.get(endpoint('/api/webrtc/status'),async req=>{const s=session(req);return rtc.diagnostics(s.owner);});
}
