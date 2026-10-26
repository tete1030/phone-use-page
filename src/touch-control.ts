import {z} from 'zod';
import {ConsoleError} from './types.js';
import type {Device} from './device.js';
import {GRID_MS,resample} from './gesture-plan.js';

const point=z.object({id:z.number().int().min(10).max(11),x:z.number().finite(),y:z.number().finite(),t:z.number().min(0).max(3600000)});
const packet=z.object({gesture:z.string().uuid(),seq:z.number().int().min(0).max(1000000),width:z.number().int().positive().max(8192),height:z.number().int().positive().max(8192)});
interface Gesture {id:string;seq:number;points:Set<number>;width:number;height:number;epoch:number;startT:number;start:{x:number;y:number};end:{x:number;y:number};maxPointers:number;distance:number;sentSamples:number;lastT?:number;lastAt?:number;compressedMs?:number}

export class TouchControl {
  private current?:Gesture;private epoch=0;private tail:Promise<unknown>=Promise.resolve();private pending=0;private resetting=false;private closed=false;private locked=false;
  private lastSeen=0;private timer?:ReturnType<typeof setInterval>;
  /** Last two real samples per pointer, kept so a batch seam has a tangent. */
  private recent=new Map<number,{x:number;y:number;t:number}[]>();
  constructor(private device:Device,private owner:string,private reply:(data:unknown)=>void,private clock=Date.now,private validate:()=>void=()=>{}){}
  private summary(g:Gesture){const durationMs=Math.max(0,(g.lastT??g.startT)-g.startT);return {kind:g.maxPointers>1?'pinch':g.distance>8?'drag':durationMs>=500?'longPress':'tap',start:g.start,end:g.end,durationMs,width:g.width,height:g.height};}
  async cancel(gesture?:string,report=true){if(gesture&&this.current?.id!==gesture)return;const g=this.current;if(report&&g?.points.size)this.reply({type:'error',gesture:g.id,cancelled:true,code:'TOUCH_CANCELLED',message:'手势已取消',...(g.sentSamples?{execution:'sent'}:{}),verification:'not_verified',summary:this.summary(g)});this.epoch++;this.current=undefined;this.resetting=true;clearInterval(this.timer);this.timer=undefined;
    const clear=async()=>{try{if(this.locked&&this.device.ownsTouch(this.owner))await this.device.video.releaseTouches();}finally{if(this.locked)this.device.endTouch(this.owner);this.locked=false;this.resetting=false;}};
    const work=this.tail.then(clear,clear);this.tail=work.catch(()=>{});await work;
  }
  close(){this.closed=true;return this.cancel();}
  async drain(){await this.tail;if(this.resetting)await this.tail;}
  keepalive(gesture:string){if(this.current?.id!==gesture||!this.locked||this.resetting)return;try{this.validate();this.device.claimTouch(this.owner);this.lastSeen=this.clock();}catch(error:any){this.reply({type:'error',gesture,cancelled:true,code:error.code,message:String(error),...(this.current.sentSamples?{execution:'sent'}:{}),summary:this.summary(this.current)});void this.cancel(undefined,false);}}
  checkTimeout(){if(this.locked&&!this.resetting&&this.clock()-this.lastSeen>5000){const g=this.current;this.reply({type:'error',gesture:g?.id,cancelled:true,code:'TOUCH_TIMEOUT',message:'触摸通信超时，手势已释放',...(g?.sentSamples?{execution:'sent'}:{}),...(g?{summary:this.summary(g)}:{})});void this.cancel(undefined,false);}}
  receive(raw:any){
    try{
      this.validate();
      if(this.closed||this.resetting)throw new ConsoleError('DEVICE_BUSY','控制正在复位，请稍后触摸',409);
      const header=packet.parse(raw),samples=raw.type==='touch-move'?z.array(point).min(1).max(64).parse(raw.points):[point.extend({action:z.union([z.literal(0),z.literal(1)])}).parse(raw)];
      let g=this.current;
      if(raw.type==='touch'&&raw.action===0&&header.seq===0){
        if(g?.points.size)throw new ConsoleError('TOUCH_SEQUENCE','上一手势尚未结束',409);
        if(!this.pending){this.device.beginTouch(this.owner);this.locked=true;}
        this.recent.clear();
        const start={x:samples[0]!.x,y:samples[0]!.y};g={id:header.gesture,seq:0,points:new Set(),width:header.width,height:header.height,epoch:this.epoch,startT:samples[0]!.t,start,end:start,maxPointers:1,distance:0,sentSamples:0};this.current=g;
      }
      if(!g||g.id!==header.gesture||g.seq!==header.seq||g.width!==header.width||g.height!==header.height)throw new ConsoleError('TOUCH_SEQUENCE','触摸序列不连续，手势已取消',409);
      const planned=new Set(g.points);
      for(const sample of samples){const action=raw.type==='touch-move'?2:(sample as any).action;
        if(sample.x<0||sample.y<0||sample.x>=g.width||sample.y>=g.height)throw new ConsoleError('INVALID_TOUCH','触摸坐标超出画面',409);
        if(action===0){if(planned.has(sample.id)||planned.size===2)throw new ConsoleError('TOUCH_SEQUENCE','触摸按下重复',409);planned.add(sample.id);g.maxPointers=Math.max(g.maxPointers,planned.size);}
        else if(!planned.has(sample.id))throw new ConsoleError('TOUCH_SEQUENCE','未收到对应按下，手势已取消',409);
        if(action===1)planned.delete(sample.id);
      }
      if(this.pending+samples.length>256)throw new ConsoleError('CONTROL_BACKLOG','控制队列积压，手势已取消；不会重放',409);
      g.points=planned;g.seq+=samples.length;this.pending+=samples.length;
      this.lastSeen=this.clock();if(!this.timer){this.timer=setInterval(()=>this.checkTimeout(),1000);this.timer.unref();}
      const gesture=g,receivedAt=this.clock(),endSeq=g.seq-1;
      const completed=raw.type==='touch'&&raw.action===1&&!planned.size;
      const work=this.tail.then(async()=>{
        if(gesture.epoch!==this.epoch||this.closed)return;
        const queueMs=this.clock()-receivedAt;if(queueMs>1000)throw new ConsoleError('CONTROL_BACKLOG','控制延迟过大，手势已取消；不会补放旧动作',409);
        const send=async(id:number,x:number,y:number)=>{
          if(this.clock()-receivedAt>1000)throw new ConsoleError('CONTROL_BACKLOG','控制延迟过大，手势已取消');
          await this.device.video.touch(2,BigInt(id),x,y,gesture.width,gesture.height,()=>{
            if(gesture.epoch!==this.epoch||this.closed)throw new ConsoleError('CONTROL_REPLACED','旧手势未重放',409);this.validate();this.device.claimTouch(this.owner);
          });
          gesture.sentSamples++;gesture.end={x,y};
          gesture.distance=Math.max(gesture.distance,Math.hypot(x-gesture.start.x,y-gesture.start.y));
        };
        if(raw.type==='touch-move'){
          // One timeline per pointer, merged back by timestamp.
          const ids=[...new Set(samples.map((sample:any)=>sample.id as number))];
          const track=new Map<number,Map<number,{x:number;y:number}>>();
          const times=new Set<number>();
          for(const id of ids){
            const own=samples.filter((sample:any)=>sample.id===id)
              .map((sample:any)=>({x:sample.x,y:sample.y,t:sample.t}))
              .sort((a:{t:number},b:{t:number})=>a.t-b.t);
            if(!own.length)continue;
            const grid=resample(own,GRID_MS,this.recent.get(id)??[]);
            // Keep the tail, not the whole batch: two points are enough for the
            // next batch's tangent and the map must not grow with gesture length.
            this.recent.set(id,own.slice(-2));
            const column=new Map<number,{x:number;y:number}>();
            for(const p of grid){column.set(p.t,{x:p.x,y:p.y});times.add(p.t);}
            track.set(id,column);
          }
          const frames=[...times].sort((a,b)=>a-b);
          if(frames.length){
            // Anchor so the first frame of this batch goes out immediately and
            // the rest follow at their real spacing. Batches are anchored where
            // they arrive, so what the device sees is the browser's timeline
            // plus network jitter -- not a compressed copy of it.
            const start=this.clock();
            const origin=frames[0]!;
            for(const t of frames){
              if(gesture.epoch!==this.epoch||this.closed)return;
              const wait=start+(t-origin)-this.clock();
              if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));
              if(gesture.epoch!==this.epoch||this.closed)return;
              this.validate();this.device.claimTouch(this.owner);
              for(const id of ids){
                const point=track.get(id)?.get(t);
                if(point)await send(id,point.x,point.y);
              }
              gesture.lastT=t;gesture.lastAt=this.clock();
            }
            // How far behind the intended timeline we finished. Non-zero means
            // injection could not keep up; report it instead of hiding it.
            const lag=Math.round(this.clock()-(start+(frames[frames.length-1]!-origin)));
            if(lag>0)gesture.compressedMs=(gesture.compressedMs??0)+lag;
          }
        } else {
          // DOWN / UP are single frames; no resampling applies.
          for(const sample of samples){
            if(gesture.epoch!==this.epoch||this.closed)return;
            this.validate();this.device.claimTouch(this.owner);
            if(this.clock()-receivedAt>1000)throw new ConsoleError('CONTROL_BACKLOG','控制延迟过大，手势已取消');
            await this.device.video.touch((sample as any).action,BigInt(sample.id),sample.x,sample.y,gesture.width,gesture.height,()=>{
              if(gesture.epoch!==this.epoch||this.closed)throw new ConsoleError('CONTROL_REPLACED','旧手势未重放',409);this.validate();this.device.claimTouch(this.owner);
            });
            gesture.sentSamples++;gesture.end={x:sample.x,y:sample.y};
            gesture.distance=Math.max(gesture.distance,Math.hypot(sample.x-gesture.start.x,sample.y-gesture.start.y));
            gesture.lastT=sample.t;gesture.lastAt=this.clock();
          }
        }
        this.reply({type:'ack',kind:raw.type==='touch-move'?'move':'touch',gesture:gesture.id,seq:endSeq,samples:samples.length,queueMs,execution:'sent',verification:'not_verified',...(gesture.compressedMs&&gesture.compressedMs>20?{compressedMs:gesture.compressedMs}:{}),...(completed?{summary:this.summary(gesture)}:{})});
      }).catch(error=>{if(gesture.epoch!==this.epoch||this.closed)return;this.reply({type:'error',gesture:gesture.id,cancelled:true,code:error.code||'CONTROL_ERROR',message:String(error),...(gesture.sentSamples?{execution:'sent'}:{}),summary:this.summary(gesture)});void this.cancel(undefined,false);})
        .finally(()=>{this.pending-=samples.length;if(!this.pending&&!this.current?.points.size&&!this.resetting){this.device.endTouch(this.owner);this.locked=false;clearInterval(this.timer);this.timer=undefined;}});
      this.tail=work.catch(()=>{});
    }catch(error:any){const g=this.current;this.reply({type:'error',gesture:raw?.gesture,cancelled:true,code:error.code||'INVALID_CONTROL',message:String(error),...(g?.sentSamples?{execution:'sent'}:{}),...(g?{summary:this.summary(g)}:{})});void this.cancel(undefined,false);}
  }
}
