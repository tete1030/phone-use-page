import {TurnCredentials,type TurnConfig} from './turn-credentials.js';
import {ConsoleError} from './types.js';

export type TurnProvider=TurnConfig['provider'];
interface Selection {broker:TurnCredentials;signal:AbortSignal;abort:()=>void}

export class TurnFallback {
  private brokers:Map<TurnProvider,TurnCredentials>;
  private selections=new Map<string,Selection>();
  readonly providers:TurnProvider[];
  constructor(primary:TurnCredentials,fallback?:TurnCredentials){
    if(fallback?.config.provider===primary.config.provider)throw new Error('Duplicate TURN provider');
    if(fallback&&fallback.config.mode!==primary.config.mode)throw new Error('TURN modes must match');
    this.brokers=new Map([primary,...(fallback?[fallback]:[])].map(b=>[b.config.provider,b]));
    this.providers=[...this.brokers.keys()];
  }
  provider(owner:string){return this.selections.get(owner)?.broker.config.provider??this.providers[0]!;}
  async prepare(owner:string,signal:AbortSignal,provider:TurnProvider=this.providers[0]!){
    const broker=this.brokers.get(provider);
    if(!broker)throw new ConsoleError('TURN_PROVIDER_DISABLED','该中继服务未启用',400);
    if(signal.aborted)throw new ConsoleError('PAGE_OFFLINE','页面已离线，视频协商已取消',409);
    let selection=this.selections.get(owner);
    if(!selection||selection.broker!==broker||selection.signal!==signal){
      this.release(owner);
      selection={broker,signal,abort:()=>this.release(owner)};
      this.selections.set(owner,selection);signal.addEventListener('abort',selection.abort,{once:true});
    }
    let prepared;
    try{prepared=await broker.prepare(owner,signal);}
    catch(error){if(this.selections.get(owner)!==selection&&!signal.aborted)throw new ConsoleError('ICE_CONFIG_EXPIRED','视频通道已更换，请重新连接视频',409);throw error;}
    if(this.selections.get(owner)!==selection||signal.aborted)throw new ConsoleError('ICE_CONFIG_EXPIRED','视频通道已更换，请重新连接视频',409);
    return {...prepared,provider,availableProviders:[...this.providers]};
  }
  server(owner:string,configId:string|undefined){
    const selection=this.selections.get(owner);
    if(!selection)throw new ConsoleError('ICE_CONFIG_EXPIRED','视频配置已过期，请重新连接视频',409);
    return selection.broker.server(owner,configId);
  }
  tlsServerName(owner:string){return this.selections.get(owner)?.broker.tlsServerName;}
  release(owner?:string){
    for(const [id,selection]of this.selections){
      if(owner&&id!==owner)continue;
      this.selections.delete(id);selection.signal.removeEventListener('abort',selection.abort);selection.broker.release(id);
    }
  }
}
