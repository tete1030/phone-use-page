import type {FastifyInstance} from 'fastify';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ConsoleError} from './types.js';
import {diagnosticText,wssFailureStages} from './wss-diagnostics.js';

export const CLIENT_VIDEO_ERROR_PATH = '/api/video/client-error';
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const reportSchema = z.object({
  provider:z.literal('wss'),stage:z.enum(wssFailureStages),code:z.string().regex(/^[A-Z0-9_]{1,64}$/),
  error:z.object({name:z.string().max(64),message:z.string().max(384)}).strict(),
  attemptId:z.string().uuid(),assetVersion:z.string().regex(/^[a-f0-9]{16}$/).nullable(),
  elapsedMs:counter,socketState:z.number().int().min(0).max(3),closeCode:z.number().int().min(0).max(4999).nullable(),
  width:z.number().int().min(0).max(32768),height:z.number().int().min(0).max(32768),codec:z.number().int().min(0).max(0xffffffff).nullable(),
  avcCodec:z.string().regex(/^avc1\.[a-f0-9]{6}$/).nullable(),bytesReceived:counter,packetsReceived:counter,drawnFrames:counter,queuedBytes:counter,
  lastPacket:z.object({kind:z.number().int().min(0).max(255).nullable(),bytes:counter,keyframe:z.boolean().optional(),nalTypes:z.array(z.number().int().min(0).max(31)).max(32).optional()}).strict().nullable(),
  decoder:z.object({format:z.literal('avc'),waitingForKey:z.boolean(),recoveries:counter,skippedFrames:counter}).strict().optional(),
  capabilities:z.object({secureContext:z.boolean(),videoDecoder:z.boolean(),createImageBitmap:z.boolean(),bitmapRenderer:z.boolean().nullable()}).strict(),
}).strict();

export function installClientVideoLog(app:FastifyInstance,endpoint:(path:string)=>string,options:{
  session:(req:any)=>{owner:string};write?:(line:string)=>void;now?:()=>number;
}) {
  const now=options.now||Date.now,write=options.write||((line:string)=>console.warn(line));
  let windowStart=now(),total=0;const counts=new Map<string,number>();
  app.post(endpoint(CLIENT_VIDEO_ERROR_PATH),{bodyLimit:8192},req=>{
    const session=options.session(req),parsed=reportSchema.safeParse(req.body);
    if(!parsed.success)throw new ConsoleError('INVALID_VIDEO_DIAGNOSTIC','视频诊断格式无效',400);
    const at=now();if(at-windowStart>=60000){windowStart=at;total=0;counts.clear();}
    const count=counts.get(session.owner)||0;
    if(count>=10||total>=60)return {ok:true,logged:false};
    counts.set(session.owner,count+1);total++;
    const report=parsed.data;
    report.error={name:diagnosticText(report.error.name,64),message:diagnosticText(report.error.message)};
    // Correlate pages without printing the connection token, cookies or raw packet data.
    const clientId=createHash('sha256').update(session.owner).digest('hex').slice(0,12);
    write(JSON.stringify({at:new Date(at).toISOString(),level:'warn',event:'wss_client_error',ip:req.ip,
      client:diagnosticText(String(req.headers['user-agent']||''),300),clientId,...report}));
    return {ok:true,logged:true};
  });
}
