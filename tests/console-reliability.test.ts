import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Device} from '../src/device.js';
import {resolveNodeClick} from '../src/node-click.js';
import {acceptsObservation,observationExpired} from '../src/observation-order.js';
import {taskResultPreview,shownNodes} from '../src/presentation.js';
import {ConsoleError,type AndroidNode} from '../src/types.js';

const node=(patch:Partial<AndroidNode>={}):AndroidNode=>({id:'label',parentId:'row',depth:1,index:0,text:'条目',description:'',resourceId:'app:id/title',className:'android.widget.TextView',package:'app',bounds:[20,20,80,40],enabled:true,clickable:false,longClickable:false,checkable:false,checked:false,focused:false,editable:false,password:false,scrollable:false,visible:true,fingerprint:'label',selector:{},instance:0,...patch});
const row=()=>node({id:'row',parentId:null,depth:0,clickable:true,bounds:[10,10,90,60],fingerprint:'row'});
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('unchanged power samples renew the lightweight status without broadcasting a UI tree',async()=>{
  const d=new Device('fixture','unused','unused'),samples:unknown[]=[];let observations=0;
  d.bridge.call=async()=>({screenOn:true,locked:false}) as any;
  d.on('power',p=>samples.push(p));d.on('observation',()=>observations++);
  await d.refreshPower();await d.refreshPower();assert.equal(samples.length,2);assert.equal(observations,0);
});

test('label click resolves its row and keeps the original label touch area',()=>{
  const label=node(),parent=row(),outer=node({id:'outer',clickable:true,parentId:null,bounds:[0,0,100,100]});parent.parentId=outer.id;
  const result=resolveNodeClick(label,[outer,parent,label],100,100);
  assert.equal(result?.target.id,parent.id);assert.deepEqual(result?.bounds,label.bounds);assert.equal(label.clickable,false);
});
test('label click refuses unrelated containers, overlays, disabled paths and cycles',()=>{
  for(const patch of [{enabled:false},{visible:false},{package:'other'},{bounds:[0,0,100,100] as AndroidNode['bounds']},{bounds:[0,0,30,30] as AndroidNode['bounds']},{clickable:false,parentId:'label'}]){
    const label=node(),parent={...row(),...patch};assert.equal(resolveNodeClick(label,[parent,label],100,100),null);
  }
  const label=node(),parent=row(),overlay=node({id:'overlay',parentId:null,clickable:true,bounds:[40,20,60,40]});assert.equal(resolveNodeClick(label,[parent,label,overlay],100,100),null);
  assert.equal(resolveNodeClick(node({text:'',description:''}),[row()],100,100),null);
});
test('inherited clicks use one touch and report both targets; long press does not inherit',async()=>{
  const d=new Device('fixture','unused','unused'),label=node(),parent=row(),touches:unknown[]=[];
  Object.assign(d.state,{nodes:[parent,label],width:100,height:100,windowId:'window',screenOn:true,locked:false,powerCollectedAt:Date.now(),controlAvailable:true});d.video.width=d.video.height=100;d.collect=async()=>structuredClone(d.state);
  d.bridge.call=async method=>{assert.equal(method,'validateNodeClick');return {valid:true} as any;};d.video.touch=async(action,id,x,y)=>{touches.push({action,x,y});};
  const target={id:label.id,fingerprint:label.fingerprint,windowId:'window'},result=await d.nodeAction('owner',target,'click',undefined,undefined,{jitter:false});
  assert.equal(result.sourceTarget,'label');assert.equal(result.actionTarget,'row');assert.deepEqual(touches,[{action:0,x:50,y:30},{action:1,x:50,y:30}]);
  await assert.rejects(d.nodeAction('owner',target,'longPress'),/长按能力/);assert.equal(touches.length,2);
  await assert.rejects(d.nodeAction('owner',{...target,windowId:'old'},'click'),/所选节点已变化/);assert.equal(touches.length,2);
});
test('native preflight failure sends no touch, even when the cached row looks clickable',async()=>{
  const d=new Device('fixture','unused','unused'),label=node(),touches:unknown[]=[];
  Object.assign(d.state,{nodes:[row(),label],width:100,height:100,windowId:'window',screenOn:true,locked:false,powerCollectedAt:Date.now(),controlAvailable:true});d.collect=async()=>d.state;
  d.bridge.call=async()=>{throw new ConsoleError('STALE_TARGET','native changed');};d.video.touch=async(...args)=>{touches.push(args);};
  await assert.rejects(d.nodeAction('owner',{id:label.id,fingerprint:label.fingerprint},'click'),/native changed/);assert.equal(touches.length,0);
});
test('a completed touch is still reported as sent when the subsequent UI read fails',async()=>{
  const d=new Device('fixture','unused','unused'),label=node({clickable:true}),touches:number[]=[];let captures=0;
  Object.assign(d.state,{nodes:[label],width:100,height:100,screenOn:true,locked:false,powerCollectedAt:Date.now(),controlAvailable:true});d.video.width=d.video.height=100;
  d.collect=async()=>{if(captures++) {d.state.uiError='unreadable';throw new ConsoleError('UI_ROOT_UNAVAILABLE','unreadable');}return d.state;};d.video.touch=async action=>{touches.push(action);};
  const result=await d.nodeAction('owner',{id:label.id,fingerprint:label.fingerprint},'click');assert.equal(result.execution,'sent');assert.equal(result.verification,'not_verified');assert.equal(result.uiError,'unreadable');assert.deepEqual(touches,[0,1]);
});
test('SDK locator resolution uses one pre-action capture inside the action queue',async()=>{
  const d=new Device('fixture','unused','unused'),label=node({clickable:true});let captures=0;
  Object.assign(d.state,{nodes:[label],width:100,height:100,screenOn:true,locked:false,powerCollectedAt:Date.now(),controlAvailable:true});d.video.width=d.video.height=100;
  d.collect=async()=>{captures++;return d.state;};d.video.touch=async()=>{};await d.nodeAction('owner',null,'click',undefined,undefined,undefined,{text:'条目'});assert.equal(captures,2);
});

function captures(){
  const d=new Device('fixture','unused','unused'),pending:{resolve:(result:any)=>void;result:any}[]=[];let text='before';
  Object.assign(d.state,{screenOn:true,locked:false,powerCollectedAt:Date.now(),controlAvailable:true,width:100,height:100});d.video.width=d.video.height=100;
  d.refreshPower=async()=>{};d.bridge.call=async method=>{assert.equal(method,'snapshot');const result={nodes:[node({text})],width:100,height:100,rotation:0,screenOn:true,locked:false,windowId:'window',elapsedMs:1};return new Promise(resolve=>pending.push({resolve,result})) as any;};
  return {d,pending,setText:(value:string)=>text=value,complete:()=>{const next=pending.shift()!;next.resolve(next.result);}};
}
test('fresh reads wait past an in-flight read and coalesce the queued next capture',async()=>{
  const f=captures(),first=f.d.collect(),fresh=f.d.collect({fresh:true}),alsoFresh=f.d.collect({fresh:true});assert.equal(fresh,alsoFresh);assert.equal(f.pending.length,1);
  f.complete();const old=await first;await tick();assert.equal(f.pending.length,1);f.complete();const latest=await fresh;
  assert.equal(old.captureSeq,1);assert.equal(latest.captureSeq,2);assert.equal(latest.snapshotId,old.snapshotId);
  latest.nodes[0]!.text='caller edit';assert.equal(f.d.state.nodes[0]!.text,'before');assert.equal(old.nodes[0]!.text,'before');
});
test('fresh reads made during the second capture schedule a third capture',async()=>{
  const f=captures(),first=f.d.collect(),second=f.d.collect({fresh:true});f.complete();await first;await tick();
  const third=f.d.collect({fresh:true});assert.notEqual(second,third);f.complete();await second;await tick();f.complete();assert.equal((await third).captureSeq,3);
});
test('post-tap observation cannot reuse the capture started before the tap',async()=>{
  const f=captures(),first=f.d.collect();f.d.video.touch=async action=>{if(action===1)f.setText('after');};
  const action=f.d.gesture('owner','tap',{x:50,y:50});// The tap holds 65-119 ms now, so wait past the longest possible press.
  await new Promise(resolve=>setTimeout(resolve,250));assert.equal(f.pending.length,1);
  f.complete();await first;await tick();f.complete();const result=await action;assert.equal(f.d.state.nodes[0]!.text,'after');assert.equal(result.verification,'not_verified');assert.equal(f.d.state.captureSeq,2);
});
test('UI root failure leaves a known connection online and rejects the old window',async()=>{
  const d=new Device('fixture','unused','unused');d.state.connected=true;d.bridge.call=async()=>{throw new ConsoleError('UI_WINDOW_UNAVAILABLE','transition',503);};
  await assert.rejects(d.collect(),/transition/);assert.equal(d.state.connected,true);assert.ok(observationExpired(d.state));
});
test('older observations and old state revisions cannot roll back the current UI',()=>{
  const d=new Device('fixture','unused','unused'),state={...d.state,collectedAt:100,captureSeq:5,observationRevision:10};
  assert.equal(acceptsObservation(state,{...state,collectedAt:200,captureSeq:4,observationRevision:20}),false);
  assert.equal(acceptsObservation(state,{...state,observationRevision:9}),false);
  assert.equal(acceptsObservation(state,{...state,observationRevision:11}),true);
  assert.equal(acceptsObservation(state,{...state,captureSeq:6}),true);
  assert.equal(observationExpired({...state,uiError:null},15101),true);
});
test('control remains unavailable until asynchronous release finishes',async()=>{
  const d=new Device('fixture','unused','unused');let release!:()=>void;d.video.release=()=>new Promise(resolve=>release=resolve);
  const resetting=d.resetControl();assert.equal(d.canClaim('owner'),false);assert.throws(()=>d.claim('owner'),/释放控制/);await tick();release();await resetting;assert.equal(d.canClaim('owner'),true);
});
test('raw keyboard queues avoid publishing an entire tree per key and retain mutual exclusion',async()=>{
  const d=new Device('fixture','unused','unused');d.claim('owner');let notifications=0;d.on('observation',()=>notifications++);
  await Promise.all(Array.from({length:100},()=>d.enqueue('owner',async()=>{},undefined,false)));assert.equal(notifications,0);assert.equal(d.canClaim('owner'),true);
  await d.enqueue('owner',async()=>{assert.equal(d.canClaim('owner'),false);d.publish();},undefined,false);assert.equal(notifications,2);assert.equal(d.canClaim('owner'),true);
});
test('small script return values and verification remain visible while large observations stay in details',()=>{
  assert.equal(taskResultPreview({nodes:[node()],foregroundApp:'app'}),'');
  assert.equal(taskResultPreview({code:'NO_EDITABLE_FOCUS'}),'{"code":"NO_EDITABLE_FOCUS"}');
  assert.equal(taskResultPreview({execution:'sent',verification:'not_verified',result:'x'.repeat(5000)}),'{"execution":"sent","verification":"not_verified"}');
  assert.equal(taskResultPreview('x'.repeat(5000)),'');
});
test('search finds displayed IDs and descendants hidden by the compact view',()=>{
  const nodes=[row(),node()];assert.equal(shownNodes(nodes,'compact','').some(n=>n.id==='label'),false);
  assert.equal(shownNodes(nodes,'compact','nlabel').some(n=>n.id==='label'),true);
  assert.equal(shownNodes(nodes,'compact','android.widget.TextView').some(n=>n.id==='label'),true);
});
