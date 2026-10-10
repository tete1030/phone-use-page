import { getQuickJS, type QuickJSDeferredPromise } from 'quickjs-emscripten';
import { sdkBootstrap } from './sdk.js';

let finished=false;const started=Date.now(),pending=new Map<number,QuickJSDeferredPromise>();let next=0;
const engine=await getQuickJS();const runtime=engine.newRuntime();runtime.setMemoryLimit(32*1024*1024);runtime.setMaxStackSize(512*1024);
runtime.setInterruptHandler(()=>finished||Date.now()-started>60000);
const context=runtime.newContext();
function send(data:unknown){if(process.connected)process.send?.(data);}
function fail(error:unknown){if(finished)return;finished=true;send({type:'failed',error:String(error)});setTimeout(()=>process.exit(1),10);}
function jobs(){const result=runtime.executePendingJobs(20);if(result.error){const error=context.dump(result.error);result.error.dispose();fail(error?.message||JSON.stringify(error));}else result.value;}
const rpc=context.newFunction('__rpc',(methodHandle,paramsHandle)=>{
  if(pending.size>=4)throw new Error('Concurrent SDK call limit exceeded');
  const params=context.getString(paramsHandle);if(Buffer.byteLength(params)>262144)throw new Error('SDK parameters exceed 256 KiB');
  const promise=context.newPromise();const id=++next;pending.set(id,promise);
  send({type:'rpc',id,method:context.getString(methodHandle),params});return promise.handle;
});context.setProp(context.global,'__rpc',rpc);rpc.dispose();
const logger=context.newFunction('__log',handle=>{const text=context.getString(handle);if(Buffer.byteLength(text)>8192)throw new Error('Log line exceeds 8192 bytes');send({type:'log',text});return context.undefined;});context.setProp(context.global,'__log',logger);logger.dispose();
const done=context.newFunction('__done',handle=>{if(finished)return context.undefined;const data=context.getString(handle);if(Buffer.byteLength(data)>1048576)throw new Error('Script result exceeds 1 MiB');finished=true;send({type:'done',result:JSON.parse(data)});setTimeout(()=>process.exit(0),10);return context.undefined;});context.setProp(context.global,'__done',done);done.dispose();
const onError=context.newFunction('__fail',handle=>{fail(context.getString(handle));return context.undefined;});context.setProp(context.global,'__fail',onError);onError.dispose();
process.on('message',(message:any)=>{
  if(message.type==='reply'){
    const promise=pending.get(message.id);if(!promise)return;pending.delete(message.id);
    if(message.ok){const value=context.newString(JSON.stringify(message.result??null));promise.resolve(value);value.dispose();}
    else {const error=context.newError({name:message.code||'DeviceError',message:message.error});promise.reject(error);error.dispose();}
    promise.dispose();jobs();
  }else if(message.type==='run'){
    const source=message.check?`(async()=>{${message.code}\n})`:`${sdkBootstrap()}\n(async()=>{${message.code}\n})().then(v=>__done(JSON.stringify(v===undefined?null:v))).catch(e=>__fail(String(e)));`;
    const result=context.evalCode(source,'user-script.js',{compileOnly:!!message.check});
    if(result.error){const error=context.dump(result.error);result.error.dispose();fail(error?.message||JSON.stringify(error));}
    else{result.value.dispose();if(message.check){finished=true;send({type:'done',result:{valid:true}});setTimeout(()=>process.exit(0),10);}else jobs();}
  }
});
setInterval(()=>{if(!finished)jobs();},10);
setTimeout(()=>fail('Script wall-clock limit exceeded'),60000);
send({type:'ready'});
