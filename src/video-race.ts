export type VideoTransport='none'|'coturn'|'cloudflare'|'wss';
export type VideoMode='auto'|VideoTransport;
export interface RaceHandle {close:()=>void;pauseChanged:()=>void;snapshot:()=>any}
export interface RaceSlot<T extends RaceHandle>{id:string;provider:VideoTransport;handle?:T;ready:boolean;closed:boolean}

export class VideoRace<T extends RaceHandle>{
  mode:VideoMode='auto';active?:RaceSlot<T>;
  private slots=new Map<VideoTransport,RaceSlot<T>>();private timers=new Map<VideoTransport,unknown>();private failures=new Map<VideoTransport,number>();private stopped=true;
  private held=false;
  holdSelection(held:boolean){this.held=held;if(!held&&!this.stopped){const best=[...this.slots.values()].sort((a,b)=>this.providers.indexOf(a.provider)-this.providers.indexOf(b.provider)).find(slot=>slot.ready&&!slot.closed&&this.eligible(slot.provider)&&(!this.active||this.providers.indexOf(slot.provider)<=this.providers.indexOf(this.active.provider)));if(best)this.promote(best);}}
  constructor(readonly providers:VideoTransport[],private options:{
    create:(slot:RaceSlot<T>,events:{ready:()=>void;failed:(reason:string)=>void})=>T;
    selected:(slot:RaceSlot<T>|undefined)=>void;
    changed:()=>void;
    schedule?:(fn:()=>void,ms:number)=>unknown;clear?:(timer:unknown)=>void;
  }){}
  private schedule(fn:()=>void,ms:number){return this.options.schedule?.(fn,ms)??setTimeout(fn,ms);}
  private clear(timer:unknown){if(this.options.clear)this.options.clear(timer);else clearTimeout(timer as ReturnType<typeof setTimeout>);}
  private eligible(provider:VideoTransport){return !this.stopped&&(this.mode==='auto'?(!this.active||this.providers.indexOf(provider)<=this.providers.indexOf(this.active.provider)):provider===this.mode);}
  start(mode:VideoMode='auto'){
    this.stopped=false;this.mode=mode;
    if(this.active&&mode!=='auto'&&this.active.provider!==mode){const active=this.active;this.active=undefined;this.options.selected(undefined);this.retire(active);}
    for(const slot of [...this.slots.values()])if(!this.eligible(slot.provider))this.retire(slot);
    for(const [provider,timer]of this.timers){this.clear(timer);this.timers.delete(provider);}
    for(const provider of this.providers)if(this.eligible(provider))this.launch(provider);
    this.options.changed();
  }
  stop(){this.stopped=true;for(const timer of this.timers.values())this.clear(timer);this.timers.clear();const active=this.active;this.active=undefined;for(const slot of [...this.slots.values()])this.retire(slot);if(active)this.retire(active);this.options.selected(undefined);}
  refresh(provider:VideoTransport){const old=this.slots.get(provider);if(old){if(old===this.active)this.slots.delete(provider);else this.retire(old);}this.launch(provider);}
  private retire(slot:RaceSlot<T>){if(slot.closed)return;slot.closed=true;if(this.slots.get(slot.provider)===slot)this.slots.delete(slot.provider);slot.handle?.close();const timer=this.timers.get(slot.provider);if(timer!==undefined){this.clear(timer);this.timers.delete(slot.provider);}}
  private launch(provider:VideoTransport){if(!this.eligible(provider)||this.slots.has(provider))return;
    const timer=this.timers.get(provider);if(timer!==undefined){this.clear(timer);this.timers.delete(provider);}
    const slot:RaceSlot<T>={id:crypto.randomUUID(),provider,ready:false,closed:false};this.slots.set(provider,slot);
    slot.handle=this.options.create(slot,{ready:()=>this.ready(slot),failed:reason=>this.failed(slot,reason)});if(slot.closed)slot.handle.close();this.options.changed();
  }
  private ready(slot:RaceSlot<T>){if(slot.closed||slot.ready||this.stopped||!this.eligible(slot.provider))return;slot.ready=true;this.failures.set(slot.provider,0);
    if(this.held&&this.active){this.options.changed();return;}this.promote(slot);
  }
  private promote(slot:RaceSlot<T>){
    if(!this.active||this.providers.indexOf(slot.provider)<this.providers.indexOf(this.active.provider)||this.active.provider===slot.provider){
      const previous=this.active;this.active=slot;this.options.selected(slot);if(previous&&previous!==slot)this.retire(previous);
      for(const other of [...this.slots.values()])if(this.providers.indexOf(other.provider)>this.providers.indexOf(slot.provider))this.retire(other);
      for(const [provider,timer]of this.timers)if(!this.eligible(provider)){this.clear(timer);this.timers.delete(provider);}
    }this.options.changed();
  }
  private failed(slot:RaceSlot<T>,_reason:string){if(slot.closed||this.stopped)return;const wasActive=this.active===slot;
    if(wasActive)this.active=undefined;this.retire(slot);if(wasActive)this.options.selected(undefined);
    const count=(this.failures.get(slot.provider)||0)+1;this.failures.set(slot.provider,count);
    if(wasActive){for(const provider of this.providers)if(this.eligible(provider))this.launch(provider);}
    else if(this.eligible(slot.provider)){const delay=Math.min(60000,5000*2**Math.min(count-1,4));this.timers.set(slot.provider,this.schedule(()=>{this.timers.delete(slot.provider);this.launch(slot.provider);},delay));}
    this.options.changed();
  }
  pauseChanged(){for(const slot of this.slots.values())slot.handle?.pauseChanged();if(this.active&&!this.slots.has(this.active.provider))this.active.handle?.pauseChanged();}
  snapshot(){return {mode:this.mode,selected:this.active?.provider||null,attempts:[...this.slots.values()].map(slot=>({attemptId:slot.id,provider:slot.provider,ready:slot.ready,...slot.handle?.snapshot()})),retrying:[...this.timers.keys()]};}
  activeHandle(){return this.active?.handle;}
}
