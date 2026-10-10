import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PageConnections} from '../src/page-connections.js';
import {HardwareKeyboard} from '../src/hardware-keyboard.js';
import {Device} from '../src/device.js';
test('heartbeats do not renew the five-minute activity deadline',()=>{
  const pages=new PageConnections(),id=pages.issue('session'),{connection}=pages.begin(id,'session');pages.complete(connection);
  connection.lastActivity=1000;pages.heartbeat(connection.owner);assert.equal(pages.idle(connection.owner,301000),true);
  pages.activity(connection.owner);assert.equal(pages.idle(connection.owner),false);
  pages.disconnect(connection);assert.throws(()=>pages.activity(connection.owner));
});
test('HID keyboard sends real key usages and releases modifiers on cleanup',async()=>{
  const reports:Uint8Array[]=[];let destroyed=false;
  const keyboard=new HardwareKeyboard({uHidCreate:async()=>{},uHidInput:async m=>{reports.push(m.data);},uHidDestroy:async()=>{destroyed=true;}});
  await keyboard.create();await keyboard.key(0,29,1);assert.deepEqual([...reports.at(-1)!],[2,0,4,0,0,0,0,0]);
  await keyboard.key(1,29,0);assert.deepEqual([...reports.at(-1)!],Array(8).fill(0));
  assert.equal(await keyboard.key(0,3,0),false);await keyboard.close();assert.equal(destroyed,true);
});
test('offline device does not start capture; connect owns awake state and disconnect closes capture',async()=>{
  const device=new Device('fixture','unused','unused');let starts=0,closes=0;const awake:boolean[]=[];
  device.bridge.call=async(method,params:any)=>{if(method==='awake'){awake.push(params.enabled);return {enabled:params.enabled} as any;}if(method==='power')return {screenOn:true,locked:false} as any;if(method==='snapshot')return {nodes:[],width:1080,height:2400,rotation:0,screenOn:true,locked:false,windowId:'fixture'} as any;return {} as any;};
  device.video.start=async()=>{starts++;device.video.client={controller:{}} as any;};device.video.close=async()=>{closes++;device.video.client=undefined;};
  try{await device.start();assert.equal(starts,0);await device.setConnected(true);assert.equal(starts,1);assert.equal(awake.at(-1),true);await device.setConnected(false);assert.equal(closes,1);assert.equal(awake.at(-1),false);assert.equal(device.state.controlAvailable,false);assert.equal(device.state.keyboardBackend,'offline');}finally{await device.stop();}
});
