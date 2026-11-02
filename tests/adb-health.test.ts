import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AdbHealth,type AdbHealthOptions,type AdbRunResult,type AdbRunner} from '../src/adb-health.js';

const serial='a6b16b87';

function fixture(initial:'device'|'offline'|'missing'){
  let state=initial;
  let fixOnRestart=true;
  const calls:string[]=[];
  const run:AdbRunner=async args=>{
    calls.push(args.join(' '));
    if(args[0]==='devices'){
      const line=state==='device'?`${serial}\tdevice\n`:state==='offline'?`${serial}\toffline\n`:'';
      return {code:0,stdout:line,stderr:''} as AdbRunResult;
    }
    if(args[0]==='reconnect'||(args[0]==='-s'&&args[2]==='reconnect')){
      if(state==='offline')state='device';
      return {code:0,stdout:'',stderr:''};
    }
    if(args[0]==='kill-server'){if(fixOnRestart)state='device';}
    return {code:0,stdout:'',stderr:''};
  };
  return {run,calls,setState:(next:'device'|'offline'|'missing')=>{state=next;},fixOnRestart:(value:boolean)=>{fixOnRestart=value;}};
}

function health(run:AdbRunner,clock:{now:number},extra:Partial<AdbHealthOptions>={}){
  let restores=0;
  const h=new AdbHealth({adbPath:'adb',serial,run,now:()=>clock.now,reconnectWaitMs:0,serverWaitMs:0,log:()=>{},onRestore:async()=>{restores++;},...extra});
  return {h,restores:()=>restores};
}

test('healthy device: no recovery commands, no restore',async()=>{
  const f=fixture('device'),clock={now:1000},{h,restores}=health(f.run,clock);
  await h.checkNow();
  assert.deepEqual(f.calls,['devices']);
  assert.equal(h.snapshot().phase,'ok');
  assert.equal(restores(),0);
});

test('offline device: reconnect only, never restarts the server',async()=>{
  const f=fixture('offline'),clock={now:1000},{h,restores}=health(f.run,clock);
  const result=await h.recover(false);
  assert.deepEqual(result.steps,['reconnect']);
  assert.ok(f.calls.includes(`-s ${serial} reconnect`));
  assert.ok(f.calls.includes('reconnect offline'));
  assert.ok(!f.calls.some(call=>call.startsWith('kill-server')));
  assert.equal(result.state.phase,'ok');
  assert.equal(restores(),1);
});

test('missing device: restarts the server once, then respects the cooldown',async()=>{
  const f=fixture('missing'),clock={now:1000},{h}=health(f.run,clock);
  const first=await h.recover(false);
  assert.deepEqual(first.steps,['reconnect','restart-server']);
  assert.equal(f.calls.filter(call=>call==='kill-server').length,1);
  assert.equal(first.state.phase,'ok');

  // 设备再次消失，但距上次重启不足冷却时间：不再 kill-server。
  f.setState('missing');f.fixOnRestart(true);clock.now+=1000;
  const second=await h.recover(false);
  assert.deepEqual(second.steps,['reconnect','restart-skipped']);
  assert.equal(f.calls.filter(call=>call==='kill-server').length,1);
});

test('repeated failures back off and then pause automatic attempts',async()=>{
  const f=fixture('missing'),clock={now:1000};
  f.fixOnRestart(false);
  const {h}=health(f.run,clock,{maxAttemptsBeforePause:2,pauseMs:300000});
  await h.checkNow();
  assert.equal(h.snapshot().phase,'degraded');
  assert.equal(h.snapshot().attempts,1);
  assert.ok((h.snapshot().nextAttemptAt??0)>clock.now);

  // 未到退避时间：只做一次廉价探测，不再执行恢复命令。
  const recoveries=()=>f.calls.filter(call=>call.includes('reconnect')||call==='kill-server').length;
  const before=recoveries();
  await h.checkNow();
  assert.equal(recoveries(),before);

  clock.now+=60000;
  await h.checkNow();
  assert.equal(h.snapshot().phase,'paused');
  const callsAtPause=recoveries();
  clock.now+=60000;
  await h.checkNow();
  assert.equal(recoveries(),callsAtPause);
});

test('manual recovery ignores the pause and resets the backoff',async()=>{
  const f=fixture('missing'),clock={now:1000};
  f.fixOnRestart(false);
  const {h}=health(f.run,clock,{maxAttemptsBeforePause:1,pauseMs:300000});
  await h.checkNow();
  assert.equal(h.snapshot().phase,'paused');

  f.fixOnRestart(true);
  const result=await h.recover(true);
  assert.ok(result.steps.includes('restart-server'));
  assert.equal(result.state.phase,'ok');
  assert.equal(result.state.attempts,0);
  assert.equal(result.state.nextAttemptAt,null);
});

test('manual recovery rebuilds the control layers even when the transport is already up',async()=>{
  const f=fixture('device'),clock={now:1000},{h,restores}=health(f.run,clock);
  const result=await h.recover(true);
  assert.deepEqual(result.steps,[]);
  assert.equal(restores(),1);
});
